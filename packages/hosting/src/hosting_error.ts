/**
 * User-facing error with structured message and resolution guidance.
 * Structured error with code, message, and resolution guidance.
 *
 * Constructor signature:
 * @example
 * ```
 * throw new HostingError('Code', { message: 'msg', resolution: 'fix' }, cause);
 * ```
 */
export class HostingError extends Error {
  public readonly resolution: string;

  /**
   * Create a new HostingError with a code, message, resolution, and optional cause.
   */
  constructor(
    public readonly code: string,
    opts: { message: string; resolution: string },
    cause?: Error,
  ) {
    super(opts.message, cause ? { cause } : undefined);
    this.name = code;
    this.resolution = opts.resolution;
  }
}
