import React, { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives';
import styles from './client.css';

export const inject = ['slots', 'connection', 'modelDirectories'];
const TABS = ['Overview', 'Policy', 'Inspect', 'Activity'];
const COVERAGE = {
  protected: ['Protected', 'Requests for the selected provider are routed through a healthy Cover daemon.'],
  blocked: ['Blocked', 'Protection is enabled, but a verified protected route is unavailable. Requests fail closed.'],
  off: ['Protection off', 'Requests bypass Cover. Sensitive content can reach the model provider unchanged.'],
  fallback: ['Unprotected fallback', 'Cover is unavailable and automatic fallback allows requests to bypass protection.'],
  unconfigured: ['Not configured', 'This provider is not covered. Only the native DeepSeek official and account providers are supported.'],
  unknown: ['Status unknown', 'A fresh connection, selected provider, and verified route are required to establish protection.'],
};
const KNOWN_PROVIDERS = new Set(['deepseek-official', 'deepseek-account']);
const STATUS_TTL_MS = 9000;
const pretty = value => typeof value === 'string' ? value : JSON.stringify(value, null, 2);

function Lock({ locked = false, className = '' }) {
  return <svg className={className} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="5" y="10" width="14" height="11" rx="3" />{locked ? <path d="M8 10V7a4 4 0 0 1 8 0v3" /> : <path d="M8 10V7a4 4 0 0 1 7.5-2" />}<path d="M12 14v3" /></svg>;
}

function createBridge() {
  let snapshot = { provider: null, docks: 0, open: false, coverage: 'unknown', fallback: false };
  const listeners = new Set();
  const providers = new Map();
  const update = patch => {
    if (Object.keys(patch).every(key => Object.is(snapshot[key], patch[key]))) return;
    snapshot = { ...snapshot, ...patch };
    listeners.forEach(listener => listener());
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    update,
    report(token, provider) {
      providers.delete(token);
      providers.set(token, provider || null);
      update({ provider: [...providers.values()].at(-1) ?? null });
      return () => { providers.delete(token); update({ provider: [...providers.values()].at(-1) ?? null }); };
    },
    dock(delta) { update({ docks: Math.max(0, snapshot.docks + delta) }); },
  };
}

function LockButton({ bridge }) {
  const state = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const coverage = Object.hasOwn(COVERAGE, state.coverage) ? state.coverage : 'unknown';
  const label = COVERAGE[coverage][0];
  return <button type="button" className={`dsc-lock dsc-tone-${coverage}`} onClick={() => bridge.update({ open: true })} aria-haspopup="dialog" aria-label={`Cover: ${label}${state.fallback ? '. Automatic unprotected fallback is on' : ''}. Open protection settings`} title="Cover protection settings"><Lock locked={coverage === 'protected' || coverage === 'blocked'} /><span className="dsc-lock-brand">Cover</span><span className="dsc-dot" /><span>{label}</span>{state.fallback && <span className="dsc-lock-fallback">Fallback on</span>}</button>;
}

function SessionControl({ bridge, directory, loadModels, dock }) {
  const selection = useSyncExternalStore(
    useCallback(listener => directory.subscribe(listener), [directory]),
    useCallback(() => directory.getSnapshot(), [directory]),
  );
  const provider = selection.status === 'ready' && selection.routable === true ? selection.current?.provider ?? null : null;
  const token = useRef(Symbol('cover-provider'));
  useEffect(() => { loadModels().catch(() => {}); }, [loadModels]);
  useEffect(() => bridge.report(token.current, provider), [bridge, provider]);
  useEffect(() => { if (!dock) return; bridge.dock(1); return () => bridge.dock(-1); }, [bridge, dock]);
  return dock ? <LockButton bridge={bridge} /> : null;
}

function Button({ children, primary, danger, ...props }) {
  return <button type="button" className={`dsc-button${primary ? ' dsc-primary' : ''}${danger ? ' dsc-danger' : ''}`} {...props}>{children}</button>;
}
function Notice({ children, danger = false }) {
  return <div className={`dsc-notice${danger ? ' dsc-notice-danger' : ''}`}>{children}</div>;
}
function Empty({ children }) { return <div className="dsc-empty">{children}</div>; }
function Output({ title, value, onClear }) {
  return <section className="dsc-output"><div className="dsc-row"><h3>{title}</h3>{onClear && <Button onClick={onClear}>Clear</Button>}</div><pre tabIndex={0}>{pretty(value)}</pre></section>;
}

function CoverApp({ bridge, connection }) {
  const shared = useSyncExternalStore(bridge.subscribe, bridge.getSnapshot);
  const generation = useSyncExternalStore(
    useCallback(listener => connection.generation.subscribe(listener), [connection]),
    useCallback(() => connection.generation.getSnapshot(), [connection]),
  );
  const generationId = generation?.id ?? null;
  const [record, setRecord] = useState(null);
  const [statusError, setStatusError] = useState(null);
  const [revision, setRevision] = useState(0);
  const [clientId] = useState(() => crypto.randomUUID());
  const [policyDirty, setPolicyDirty] = useState(false);
  const [dismissRequest, setDismissRequest] = useState(0);
  const latestRecord = useRef(null);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  const invalidate = useCallback(message => {
    latestRecord.current = null;
    setRecord(null);
    setStatusError(message || 'Live status could not be verified.');
    bridge.update({ coverage: 'unknown' });
  }, [bridge]);
  const rpc = useCallback(async (endpoint, payload = {}, signal) => {
    let result;
    try {
      result = await fetch(`api/ds-cover/${endpoint}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-ds-cover-client': clientId },
        body: JSON.stringify(payload),
        signal,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      throw new Error('Cover could not reach the host. Check the host connection and try again.');
    }
    let response;
    try { response = await result.json(); }
    catch {
      if (signal?.aborted) throw new Error('Cover request cancelled.');
      throw new Error('Cover returned an unreadable response. Check the host connection and try again.');
    }
    const safeMessage = response?.error?.message;
    if (response?.ok === false && typeof safeMessage === 'string' && safeMessage) {
      throw new Error(safeMessage);
    }
    if (!result.ok || response?.ok !== true) {
      throw new Error('Cover could not complete this request. Check the host connection and local Cover configuration.');
    }
    return response.value;
  }, [clientId]);
  useEffect(() => {
    latestRecord.current = null;
    setRecord(null);
    setStatusError(null);
    bridge.update({ coverage: 'unknown' });
  }, [bridge, generationId, shared.provider]);
  useEffect(() => {
    if (generationId === null) return undefined;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        const value = await rpc('status', { provider: shared.provider }, controller.signal);
        if (!controller.signal.aborted) {
          const next = { value, generationId, provider: shared.provider, receivedAt: Date.now() };
          latestRecord.current = next;
          setRecord(next);
          setStatusError(null);
        }
      } catch (failure) {
        if (!controller.signal.aborted) invalidate(failure?.message);
      } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 4000); }
    };
    poll();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [rpc, generationId, shared.provider, revision, invalidate]);
  // Freshness is owned by the record, not the poll effect. A manual refresh or
  // operation-triggered revision cannot extend the lifetime of an old status.
  useEffect(() => {
    if (!record) return undefined;
    const age = Number.isFinite(record.receivedAt) ? Date.now() - record.receivedAt : 0;
    const timer = setTimeout(() => {
      if (latestRecord.current !== record) return;
      invalidate('Live status has not refreshed. Protection could not be verified.');
    }, Math.max(0, STATUS_TTL_MS - age));
    return () => clearTimeout(timer);
  }, [record, invalidate]);
  const status = record?.generationId === generationId && record?.provider === shared.provider ? record.value : null;
  let coverage = status && Object.hasOwn(COVERAGE, status.coverage) ? status.coverage : 'unknown';
  if (coverage === 'protected' && (!KNOWN_PROVIDERS.has(shared.provider) || status.provider !== shared.provider || !status.running || !status.enabled)) coverage = 'unknown';
  const fallback = status?.autoFallback === true;
  useEffect(() => { bridge.update({ coverage, fallback }); }, [bridge, coverage, fallback]);
  useEffect(() => {
    if (!shared.open) { setPolicyDirty(false); setDismissRequest(0); }
  }, [shared.open]);
  const requestClose = useCallback(() => {
    if (policyDirty) setDismissRequest(value => value + 1);
    else { setDismissRequest(0); bridge.update({ open: false }); }
  }, [bridge, policyDirty]);
  const discardAndClose = useCallback(() => {
    setPolicyDirty(false);
    setDismissRequest(0);
    bridge.update({ open: false });
  }, [bridge]);
  return <>
    {!shared.docks && <div className="dsc-footer"><LockButton bridge={bridge} />{fallback && <span className="dsc-footer-warning" role="status">Automatic fallback on: the next request may bypass Cover.</span>}<span className="dsc-footer-caption">Local privacy controls</span></div>}
    <Modal open={shared.open} onClose={requestClose} title="Cover" description="Local protection for native DeepSeek requests" closeLabel="Close Cover settings" className="dsc-modal" contentClassName="dsc-modal-content">
      {/* A new connection generation remounts the panel, clearing inspect state and running the live-view cleanup. */}
      {shared.open && <Panel key={generationId === null ? 'disconnected' : String(generationId)} generationId={generationId} rpc={rpc} status={status} coverage={coverage} provider={shared.provider} statusError={statusError} refresh={refresh} connected={generationId !== null} onDirtyChange={setPolicyDirty} dismissRequest={dismissRequest} onDiscardClose={discardAndClose} />}
    </Modal>
  </>;
}

const CHECK_LABELS = { ok: 'OK', warning: 'Warning', error: 'Error' };

function policyLabel(status) {
  if (!status) return 'Not checked';
  if (status.policyState === 'active') return 'Applied';
  if (status.policyState === 'pending') return status.restartRequired ? 'Pending restart' : 'Pending apply';
  if (status.policyState === 'unknown') return 'Unknown';
  return 'Unavailable';
}

function Panel({ rpc, status, coverage, provider, statusError, refresh, connected, generationId, onDirtyChange, dismissRequest, onDiscardClose }) {
  const [tab, setTab] = useState('Overview');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [output, setOutput] = useState(null);
  const [confirmation, setConfirmation] = useState(null);
  const [dirty, setDirty] = useState(false);
  const [policyVisited, setPolicyVisited] = useState(false);
  const [leavePrompt, setLeavePrompt] = useState(false);
  const [focusPolicyTab, setFocusPolicyTab] = useState(false);
  const [setup, setSetup] = useState({ state: 'idle', checks: [], message: '' });
  const requests = useRef(new Set());
  const setupRequest = useRef(null);
  const keepEditingRef = useRef(null);
  const lastDismissRequest = useRef(dismissRequest);
  const mounted = useRef(true);
  const tabId = useId();
  const tabRefs = useRef([]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requests.current.forEach(controller => controller.abort());
      requests.current.clear();
      setupRequest.current?.abort();
    };
  }, []);
  const run = useCallback(async (endpoint, payload, onSuccess) => {
    const controller = new AbortController();
    requests.current.add(controller);
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await rpc(endpoint, payload, controller.signal);
      if (mounted.current && !controller.signal.aborted) onSuccess?.(result);
      return result;
    } catch (failure) {
      if (mounted.current && !controller.signal.aborted) setError(failure?.message || 'Cover operation failed.');
    } finally {
      requests.current.delete(controller);
      if (mounted.current) { setBusy(false); refresh(); }
    }
  }, [rpc, refresh]);
  const reportDirty = useCallback(value => { setDirty(value); onDirtyChange(value); }, [onDirtyChange]);
  useEffect(() => { if (!dirty) setLeavePrompt(false); }, [dirty]);
  useEffect(() => {
    if (dismissRequest <= lastDismissRequest.current) return;
    lastDismissRequest.current = dismissRequest;
    if (dirty) setLeavePrompt(true);
  }, [dismissRequest, dirty]);
  useEffect(() => { if (leavePrompt) keepEditingRef.current?.focus?.(); }, [leavePrompt]);
  useEffect(() => {
    if (!focusPolicyTab || tab !== 'Policy') return;
    tabRefs.current[1]?.focus?.();
    setFocusPolicyTab(false);
  }, [focusPolicyTab, tab]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  const loadSetup = useCallback(async () => {
    setupRequest.current?.abort();
    const controller = new AbortController();
    setupRequest.current = controller;
    setSetup(current => ({ ...current, state: 'loading', message: '' }));
    try {
      const value = await rpc('setup', {}, controller.signal);
      if (controller.signal.aborted) return;
      if (!Array.isArray(value?.checks)) throw new Error('Cover did not return setup checks.');
      setSetup({ state: 'ready', checks: value.checks, message: '' });
    } catch (failure) {
      if (!controller.signal.aborted) setSetup({ state: 'error', checks: [], message: failure?.message || 'Setup checks could not be completed.' });
    } finally {
      if (setupRequest.current === controller) setupRequest.current = null;
    }
  }, [rpc]);
  useEffect(() => { if (connected && tab === 'Overview' && setup.state === 'idle') loadSetup(); }, [connected, tab, setup.state, loadSetup]);
  const disabled = busy || status?.busy || !connected;
  const action = (name, label) => run('action', { name }, result => setOutput({ title: label, value: result }));
  const confirm = (title, description, execute) => setConfirmation({ title, description, execute });
  const requestRestart = () => confirm('Restart Cover?', 'The dedicated daemon will be interrupted. Active requests may fail. New requests follow your fallback setting until Cover is healthy again.', () => action('restart', 'Restart daemon'));
  const stateChange = change => run('state', change, () => setNotice('Protection settings saved.'));
  const selectTab = next => {
    if (next === 'Policy') setPolicyVisited(true);
    setTab(next);
    setConfirmation(null);
    setLeavePrompt(false);
  };
  const keepEditing = () => { setLeavePrompt(false); setPolicyVisited(true); setTab('Policy'); setFocusPolicyTab(true); };
  const checkedDate = Number.isFinite(status?.checkedAt) ? new Date(status.checkedAt) : null;
  const validCheckedDate = checkedDate && !Number.isNaN(checkedDate.getTime()) ? checkedDate : null;
  return <div className="dsc-panel">
    <section className={`dsc-summary dsc-tone-${coverage}`} aria-label="Current protection status">
      <div className="dsc-summary-icon"><Lock locked={coverage === 'protected' || coverage === 'blocked'} /></div>
      <div><div className="dsc-eyebrow">REQUEST PROTECTION</div><h2><span className="dsc-dot" />{COVERAGE[coverage][0]}</h2><p>{COVERAGE[coverage][1]}</p></div>
    </section>
    <div className="dsc-cards">
      <div><span>Selected provider</span><strong>{provider || 'No provider selected'}</strong></div>
      <div><span>Local daemon</span><strong>{status ? status.running ? 'Healthy' : 'Not ready' : 'Checking connection'}</strong></div>
      <div><span>Active requests</span><strong>{Number.isInteger(status?.activeRequests) ? status.activeRequests : 'Not available'}</strong></div>
    </div>
    <div className="dsc-meta">
      <span>Policy: <strong>{policyLabel(status)}</strong></span>
      {validCheckedDate && <span>Last health check: <time dateTime={validCheckedDate.toISOString()}>{validCheckedDate.toLocaleString()}</time></span>}
    </div>
    {statusError && <div className="dsc-alert" role="alert"><Notice danger><strong>Live status could not be verified.</strong> {statusError} Protection is not established by this display. <Button onClick={refresh} disabled={busy || !connected}>Retry</Button></Notice></div>}
    {typeof status?.error === 'string' && status.error && <div className="dsc-alert" role="status"><Notice danger><strong>Cover status:</strong> {status.error}</Notice></div>}
    {status?.restartRequired === true && <div className="dsc-banner" role="status"><div><strong>Restart required.</strong> Saved policy changes are not active until Cover restarts.</div><Button onClick={requestRestart} disabled={disabled}>Restart Cover</Button></div>}
    <div className="dsc-tabs" role="tablist" aria-label="Cover settings">
      {TABS.map((name, index) => <button type="button" key={name} role="tab" id={`${tabId}-${name}`} aria-controls={`${tabId}-panel`} aria-selected={tab === name} tabIndex={tab === name ? 0 : -1} ref={node => { tabRefs.current[index] = node; }} data-modal-autofocus={index === 0 ? '' : undefined} onClick={() => selectTab(name)} onKeyDown={event => {
        let next;
        if (event.key === 'ArrowRight') next = (index + 1) % TABS.length;
        if (event.key === 'ArrowLeft') next = (index + TABS.length - 1) % TABS.length;
        if (event.key === 'Home') next = 0;
        if (event.key === 'End') next = TABS.length - 1;
        if (next !== undefined) { event.preventDefault(); selectTab(TABS[next]); tabRefs.current[next]?.focus(); }
      }}>{name}</button>)}
    </div>
    <div className="dsc-tabpanel" role="tabpanel" id={`${tabId}-panel`} aria-labelledby={`${tabId}-${tab}`}>
      {error && <div className="dsc-feedback dsc-error" role="alert">{error}</div>}
      {notice && <div className="dsc-feedback" role="status">{notice}</div>}
      {busy && <div className="dsc-working" role="status">Working locally. Downloads and updates may take several minutes.</div>}
      {leavePrompt && <section className="dsc-confirm" role="alertdialog" aria-labelledby={`${tabId}-leave-title`} aria-describedby={`${tabId}-leave-description`}><h3 id={`${tabId}-leave-title`}>Discard unsaved policy changes?</h3><p id={`${tabId}-leave-description`}>Your policy edits have not been saved in this panel. Closing Cover discards them. Any save already in progress may still complete.</p><div className="dsc-actions"><Button danger onClick={onDiscardClose}>Discard changes &amp; close</Button><button type="button" className="dsc-button" ref={keepEditingRef} onClick={keepEditing}>Keep editing</button></div></section>}
      {confirmation && <section className="dsc-confirm" role="alert" aria-label={confirmation.title}><h3>{confirmation.title}</h3><p>{confirmation.description}</p><div className="dsc-actions"><Button danger disabled={disabled} onClick={() => { const execute = confirmation.execute; setConfirmation(null); execute(); }}>Confirm</Button><Button disabled={busy} onClick={() => setConfirmation(null)}>Cancel</Button></div></section>}
      <div hidden={tab !== 'Overview'}>
        <section className="dsc-section"><div className="dsc-setting"><div><h3>Protect native DeepSeek requests</h3><p>Route requests through the dedicated local Cover instance. Turning this on does not start the daemon.</p></div><button type="button" className="dsc-switch" role="switch" aria-label="Protect native DeepSeek requests" aria-checked={status?.enabled === true} disabled={disabled || !status} onClick={() => status.enabled ? confirm('Turn protection off?', 'New requests will bypass Cover and may send original sensitive content to DeepSeek. In-flight requests keep their existing route.', () => stateChange({ enabled: false })) : stateChange({ enabled: true })}><span /></button></div>
          <div className="dsc-setting"><div><h3>Automatic fallback <span className="dsc-tag">Opt-in</span></h3><p>Bypass Cover if it is unavailable. Leave this off to block requests instead of sending unprotected content.</p></div><button type="button" className="dsc-switch" role="switch" aria-label="Automatic unprotected fallback" aria-checked={status?.autoFallback === true} disabled={disabled || !status} onClick={() => status.autoFallback ? stateChange({ autoFallback: false }) : confirm('Allow unprotected fallback?', 'If Cover is unavailable, original request content can leave this host and reach DeepSeek without redaction. This is a persistent setting, not a one-time exception.', () => stateChange({ autoFallback: true }))}><span /></button></div>
          {status?.autoFallback && <Notice danger>Automatic fallback is enabled. Availability takes priority over protection if Cover goes offline.</Notice>}
        </section>
        <section className="dsc-section"><div className="dsc-section-heading"><h3>Daemon &amp; diagnostics</h3><span>Runs only when requested</span></div><div className="dsc-actions"><Button primary disabled={disabled} onClick={() => action('start', 'Start daemon')}>Start</Button><Button disabled={disabled} onClick={() => confirm('Stop the Cover daemon?', 'Protected requests will be blocked while Cover is stopped, or sent unprotected if automatic fallback is enabled. Active requests may be interrupted.', () => action('stop', 'Stop daemon'))}>Stop</Button><Button disabled={disabled} onClick={requestRestart}>Restart</Button><Button disabled={disabled} onClick={() => action('doctor', 'Doctor report')}>Doctor</Button><Button disabled={disabled} onClick={() => action('test', 'Protection test')}>Test</Button><Button disabled={disabled} onClick={() => action('version', 'Installed version')}>Version</Button></div><p className="dsc-caption">Diagnostic output appears only on request. It stays in this panel and is never added to a conversation.</p></section>
        <section className="dsc-section dsc-setup"><div className="dsc-section-heading"><h3>Setup checks</h3><Button onClick={loadSetup} disabled={!connected || setup.state === 'loading'}>Recheck setup</Button></div><p>Verify the local binary, daemon port, router route, and harness compatibility without changing protection.</p>
          {setup.state === 'loading' && setup.checks.length === 0 && <Empty>Checking local setup…</Empty>}
          {setup.state === 'error' && <div role="alert"><Notice danger>{setup.message}</Notice></div>}
          {setup.checks.length > 0 && <ul className="dsc-checks" aria-label="Setup checks">{setup.checks.map((check, index) => {
            const state = Object.hasOwn(CHECK_LABELS, check?.state) ? check.state : 'warning';
            const label = typeof check?.label === 'string' ? check.label : typeof check?.id === 'string' ? check.id : 'Check';
            const message = typeof check?.message === 'string' ? check.message : '';
            const id = typeof check?.id === 'string' ? check.id : index;
            return <li className={`dsc-check dsc-check-${state}`} key={id}><span className="dsc-check-state">{CHECK_LABELS[state]}</span><span className="dsc-check-label">{label}</span><span className="dsc-check-message">{message}</span></li>;
          })}</ul>}
          {setup.state === 'loading' && setup.checks.length > 0 && <p className="dsc-caption" role="status">Rechecking setup…</p>}
        </section>
        <details className="dsc-advanced"><summary>Advanced management</summary>
          <section className="dsc-section"><div className="dsc-section-heading"><h3>Local detection models</h3><span>On-device processing</span></div><p>Check installed model availability or download the models used by Cover’s local detectors.</p><div className="dsc-actions"><Button disabled={disabled} onClick={() => action('models', 'Local model status')}>Model status</Button><Button disabled={disabled} onClick={() => confirm('Download detection models?', 'Cover will contact its model download sources for approximately 490 MB of models and runtime files, using local disk space. This can take several minutes. Existing requests may be affected if the daemon reloads models.', () => action('models-pull', 'Model download'))}>Download models</Button></div></section>
          <section className="dsc-section"><h3>Cover installation</h3><p>Updates and rollbacks change the shared installed Cover binary, which can affect other integrations as well as this plugin. Save your work before continuing.</p><div className="dsc-actions"><Button disabled={disabled} onClick={() => confirm('Update Cover?', 'This downloads and installs a Cover release. The shared installed binary may be used by other integrations. Daemon interruption and download or disk usage are possible.', () => action('update', 'Cover update'))}>Update</Button><Button disabled={disabled} onClick={() => confirm('Roll back Cover?', 'This restores the previous installed release when available. It changes the shared Cover binary used by other integrations and may interrupt the daemon or change supported policy rules.', () => action('rollback', 'Cover rollback'))}>Roll back</Button></div></section>
        </details>
        <details className="dsc-route"><summary>Routing details</summary><dl><dt>Router</dt><dd>{status?.routerURL || 'Not verified'}</dd><dt>Cover listener</dt><dd>{status?.baseURL || 'Not verified'}</dd><dt>Upstream</dt><dd>{status?.upstream || 'Not verified'}</dd></dl><p>Coverage applies to the selected provider’s next request. Existing requests retain the route selected when they began.</p></details>
        {output && <Output title={output.title} value={output.value} onClear={() => setOutput(null)} />}
      </div>
      {policyVisited && <div hidden={tab !== 'Policy'}><Policy rpc={rpc} run={run} disabled={disabled} onDirtyChange={reportDirty} /></div>}
      {tab === 'Inspect' && <Inspect key={generationId === null ? 'disconnected' : String(generationId)} run={run} disabled={disabled} />}
      {/* Keyed separately so an in-place generation change still unmounts the live view and its pending polls. */}
      {tab === 'Activity' && <Activity key={generationId === null ? 'disconnected' : String(generationId)} rpc={rpc} disabled={disabled} />}
    </div>
    <div className="dsc-panel-footer"><span>Cover runs on this host. Protection is provider-specific.</span><Button onClick={refresh} disabled={disabled}>Refresh status</Button></div>
  </div>;
}

function Policy({ rpc, run, disabled, onDirtyChange }) {
  const [text, setText] = useState('');
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState('');
  const [revision, setRevision] = useState(0);
  const draft = useRef(text);
  const id = useId();
  useEffect(() => { draft.current = text; }, [text]);
  useEffect(() => onDirtyChange(text !== saved), [text, saved, onDirtyChange]);
  useEffect(() => () => onDirtyChange(false), [onDirtyChange]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setLoadError('');
    rpc('policy', {}, controller.signal).then(value => {
      if (!controller.signal.aborted) { setText(value); setSaved(value); }
    }).catch(failure => { if (!controller.signal.aborted) setLoadError(failure?.message || 'Policy could not be loaded.'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [rpc, revision]);
  const save = () => {
    const pending = text;
    run('savePolicy', { text: pending }, () => {
      setSaved(pending);
      setMessage(draft.current === pending
        ? 'Policy saved and validated. Restart Cover to apply it to requests.'
        : 'Policy saved. Your newer edits remain unsaved.');
    });
  };
  return <section className="dsc-section dsc-policy"><h3>Policy YAML</h3><p>Edit the complete Cover policy, including detection categories, actions, custom rules, and allowlists. The dedicated loopback, upstream, session header, and private storage boundaries must remain unchanged.</p><Notice>Saving validates the policy locally. Restart the daemon from Overview to apply changes to model requests.</Notice>{loading ? <Empty>Loading the current policy…</Empty> : loadError ? <Empty>{loadError} <Button onClick={() => setRevision(value => value + 1)} disabled={disabled}>Retry</Button></Empty> : <><label className="dsc-label" htmlFor={id}>Complete Cover configuration</label><textarea id={id} className="dsc-editor dsc-policy-editor" value={text} onChange={event => { setText(event.target.value); setMessage(''); }} spellCheck={false} autoCapitalize="off" autoComplete="off" disabled={disabled} /><div className="dsc-row"><span className="dsc-caption">{text === saved ? 'No unsaved changes' : 'Unsaved changes'}</span><Button primary disabled={disabled || text === saved} onClick={save}>Save policy</Button></div>{message && <div className="dsc-feedback" role="status">{message}</div>}</>}</section>;
}

function Inspect({ run, disabled }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState(null);
  const [error, setError] = useState('');
  const id = useId();
  const preview = () => {
    try { const value = JSON.parse(text); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); }
    catch { setError('Enter a valid JSON request object.'); return; }
    setError(''); setResult(null);
    run('inspect', { text }, setResult);
  };
  return <section className="dsc-section"><h3>Inspect a request locally</h3><p>Preview how the saved policy transforms a JSON request. Nothing is sent to DeepSeek or inserted into a conversation. Preview input is not retained after this panel closes.</p><Notice>The input travels to this host for local inspection. Cover uses a private temporary file that is removed after inspection.</Notice><label className="dsc-label" htmlFor={id}>Request JSON</label><textarea id={id} className="dsc-editor" value={text} onChange={event => { setText(event.target.value); setResult(null); setError(''); }} spellCheck={false} autoComplete="off" autoCapitalize="off" disabled={disabled} />{error && <div className="dsc-feedback dsc-error" role="alert">{error}</div>}<div className="dsc-actions"><Button primary disabled={disabled || !text.trim()} onClick={preview}>Preview locally</Button><Button disabled={disabled || (!text && result === null)} onClick={() => { setText(''); setResult(null); setError(''); }}>Clear input & result</Button></div>{result !== null && <>
    <div className="dsc-feedback" role="status">{result.blocked === true ? 'The policy blocks this request.' : result.blocked === false ? 'The policy permits this transformed request.' : 'Inspection complete.'}{Number.isInteger(result.transformed) ? ` ${result.transformed} transformation${result.transformed === 1 ? '' : 's'}.` : ''}</div>
    {Array.isArray(result.categories) && <div className="dsc-event-categories">{result.categories.map(category => <span className="dsc-tag" key={category}>{category}</span>)}</div>}
    <Output title="Transformed payload" value={result.transformed_request ?? result} />
    {Array.isArray(result.matches) && <Output title="Matched rules & actions" value={result.matches} />}
  </>}</section>;
}

function ActivityEvent({ event }) {
  return <li className="dsc-event">
    <div className="dsc-event-meta">
      {typeof event.time === 'string' && <time dateTime={event.time}>{event.time}</time>}
      {Number.isFinite(event.status) && <strong>HTTP {event.status}</strong>}
      {Number.isInteger(event.transformed) && <span>{event.transformed} transformed</span>}
      {Number.isFinite(event.duration_ms) && <span>{event.duration_ms} ms</span>}
      {Number.isFinite(event.sent_bytes) && <span>{event.sent_bytes.toLocaleString()} bytes sent</span>}
      {Number.isFinite(event.returned_bytes) && <span>{event.returned_bytes.toLocaleString()} bytes returned</span>}
    </div>
    {Array.isArray(event.categories) && <div className="dsc-event-categories">{event.categories.map(category => <span key={category} className="dsc-tag">{category}</span>)}</div>}
    {typeof event.error === 'string' && <p className="dsc-feedback dsc-error">{event.error}</p>}
    {typeof event.explanation === 'string' && <p className="dsc-caption">{event.explanation}</p>}
    {typeof event.next_step === 'string' && <p className="dsc-caption">{event.next_step}</p>}
  </li>;
}

function Activity({ rpc, disabled }) {
  const [events, setEvents] = useState(null);
  const [error, setError] = useState('');
  const [revision, setRevision] = useState(0);
  const [consent, setConsent] = useState(false);
  const [live, setLive] = useState(false);
  const [liveEvents, setLiveEvents] = useState([]);
  const [liveState, setLiveState] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    setEvents(null); setError('');
    rpc('activity', {}, controller.signal).then(value => { if (!controller.signal.aborted) setEvents(value); }).catch(failure => { if (!controller.signal.aborted) setError(failure?.message || 'Activity could not be loaded.'); });
    return () => controller.abort();
  }, [rpc, revision]);
  useEffect(() => {
    if (!live) { setLiveEvents([]); return; }
    const controller = new AbortController();
    let id;
    let timer;
    let cancelled = false;
    setLiveEvents([]); setLiveState('Connecting to the sensitive live view…');
    const stop = value => { if (value) rpc('liveStop', { id: value }).catch(() => {}); };
    const poll = async () => {
      try {
        const result = await rpc('livePoll', { id }, controller.signal);
        if (cancelled) return;
        if (result?.error) throw new Error(typeof result.error === 'string' ? result.error : 'Live monitor disconnected.');
        setLiveEvents(current => [...current, ...(Array.isArray(result?.events) ? result.events : [])].slice(-10));
        setLiveState('Listening. Only new live events appear here.');
        timer = setTimeout(poll, 1500);
      } catch (failure) {
        if (!cancelled) { setLiveState(failure?.message || 'Live view ended. Enable it again to reconnect.'); setLive(false); setConsent(false); }
      }
    };
    rpc('liveStart', {}).then(value => {
      id = value;
      if (cancelled) { stop(id); return; }
      poll();
    }).catch(failure => { if (!cancelled) { setLiveState(failure?.message || 'The sensitive live view could not start.'); setLive(false); setConsent(false); } });
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); stop(id); setLiveEvents([]); };
  }, [rpc, live]);
  return <>
    <section className="dsc-section"><div className="dsc-section-heading"><h3>Recent activity</h3><Button disabled={disabled} onClick={() => setRevision(value => value + 1)}>Refresh activity</Button></div><p>Recent metadata from the dedicated Cover instance. This can include requests from other sessions routed through the same instance.</p>{error ? <Empty>{error}</Empty> : events === null ? <Empty>Loading activity…</Empty> : !events.length ? <Empty>No recorded activity yet. Protected requests will appear here when Cover records them.</Empty> : <ol className="dsc-events">{events.map((event, index) => <ActivityEvent key={index} event={event} />)}</ol>}</section>
    <section className="dsc-section"><div className="dsc-section-heading"><h3>Sensitive live view</h3><span className="dsc-tag">Explicit opt-in</span></div><Notice danger>This view can expose original sensitive content. Originals leave the host and are delivered to this authenticated browser. Do not enable it while screen sharing or on an untrusted device. Content is never sent to the model by this panel.</Notice>{!live ? <><label className="dsc-consent"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} disabled={disabled} /><span>I understand that original content will be visible in this browser.</span></label><Button danger disabled={disabled || !consent} onClick={() => setLive(true)}>Enable sensitive live view</Button></> : <div className="dsc-row"><span className="dsc-live-indicator">Sensitive live view is active</span><Button danger onClick={() => { setLive(false); setConsent(false); setLiveEvents([]); setLiveState('Live view stopped. Displayed content cleared.'); }}>Stop &amp; clear</Button></div>}{liveState && <p className="dsc-caption" role="status">{liveState}</p>}{live && (liveEvents.length ? <div className="dsc-live-events">{liveEvents.map((event, index) => <pre key={index} tabIndex={0}>{pretty(event)}</pre>)}</div> : <Empty>No live events received.</Empty>)}<p className="dsc-caption">Stops and clears on tab change, panel close, connection reset, or plugin unload. Only the latest ten live events are held in this view.</p></section>
  </>;
}

export function apply(ctx) {
  const bridge = createBridge();
  ctx.effect(() => {
    const style = document.createElement('style');
    style.dataset.plugin = 'ds-cover';
    style.dataset.pluginCss = 'ds-cover/client';
    style.textContent = styles;
    document.head.append(style);
    return () => style.remove();
  });
  ctx.slots.inject('shell.bottom', () => ctx.slots.register({ name: 'shell.bottom', id: 'ds-cover-footer', inject: () => ({ bridge, connection: ctx.connection }) }, CoverApp));
  for (const [name, dock] of [['conversation.composer.dock', true], ['conversation.input.right', false]]) {
    ctx.slots.inject(name, () => ctx.slots.register({ name, id: dock ? 'ds-cover-lock' : 'ds-cover-provider', order: 2, inject: sessionId => {
      const directory = ctx.modelDirectories.directoryFor(sessionId);
      return { bridge, dock, directory: directory.store, loadModels: () => directory.load() };
    } }, SessionControl));
  }
}
