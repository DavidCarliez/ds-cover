// Only messages safe for the authenticated control panel belong in this type.
export class CoverError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CoverError';
    this.code = code;
  }
}
