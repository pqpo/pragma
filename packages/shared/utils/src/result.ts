export type Result<TValue, TError = Error> =
  | { ok: true; value: TValue }
  | { ok: false; error: TError };

export const ok = <TValue>(value: TValue): Result<TValue> => ({ ok: true, value });

export const err = <TError>(error: TError): Result<never, TError> => ({ ok: false, error });
