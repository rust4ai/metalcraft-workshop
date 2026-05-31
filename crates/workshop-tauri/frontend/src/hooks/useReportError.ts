import { createContext, useContext } from "react";

/**
 * Surfaces a failed operation to the global error banner (bottom-right in
 * App.tsx). `context` is a short label for the action that failed, e.g.
 * "delete_persona"; `error` is whatever the rejected invoke threw.
 *
 * The default implementation only logs — used when a component renders
 * outside the provider (e.g. in isolation/tests).
 *
 * `sessionId`, when given, is the diagnostics session the failed action belongs
 * to; the error banner uses it to deep-link to that session's logs.
 */
export type ReportError = (
  context: string,
  error: unknown,
  sessionId?: string | null,
) => void;

const ErrorContext = createContext<ReportError>((context, error) => {
  console.error(context, error);
});

export const ErrorProvider = ErrorContext.Provider;

export function useReportError(): ReportError {
  return useContext(ErrorContext);
}
