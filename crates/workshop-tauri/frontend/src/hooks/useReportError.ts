import { createContext, useContext } from "react";

/**
 * Surfaces a failed operation to the global error banner (bottom-right in
 * App.tsx). `context` is a short label for the action that failed, e.g.
 * "delete_persona"; `error` is whatever the rejected invoke threw.
 *
 * The default implementation only logs — used when a component renders
 * outside the provider (e.g. in isolation/tests).
 */
export type ReportError = (context: string, error: unknown) => void;

const ErrorContext = createContext<ReportError>((context, error) => {
  console.error(context, error);
});

export const ErrorProvider = ErrorContext.Provider;

export function useReportError(): ReportError {
  return useContext(ErrorContext);
}
