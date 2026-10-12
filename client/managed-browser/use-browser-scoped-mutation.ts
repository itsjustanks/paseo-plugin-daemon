/**
 * Own mutation publication and settlement for one mounted host/workspace/viewer/
 * control incarnation. Replies from a replaced incarnation are discarded, not
 * replayed. Server authority and state-generation ordering remain independent.
 */
import { useMutation } from "@tanstack/react-query";
import { useLayoutEffect, useRef } from "react";

interface ScopedMutationOptions<Input, Result> {
  /** Includes host, workspace, viewer token and current control token. */
  identity: string;
  /** Optional synchronous identity read for state observed before React commits. */
  currentIdentity?(): string;
  mutationFn(input: Input): Promise<Result>;
  onSuccess(result: Result): void;
  onError(error: unknown): void;
}

/** Capture identity with immutable variables before React Query can await work.
 * A retained callback cannot publish against a replacement, and late callbacks
 * cannot restore its predecessor's control token, state, error or refresh intent. */
export function useBrowserScopedMutation<Input, Result>(
  options: ScopedMutationOptions<Input, Result>,
) {
  const current = useRef(options);
  current.current = options;
  const mounted = useRef(true);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const isCurrent = (identity: string) =>
    mounted.current &&
    (current.current.currentIdentity?.() ?? current.current.identity) === identity;
  const mutation = useMutation({
    mutationFn: (request: { input: Input; identity: string }) => {
      if (!isCurrent(request.identity)) {
        throw new Error("Browser viewer or control context changed.");
      }
      return current.current.mutationFn(request.input);
    },
    retry: false,
    onSuccess: (result, request) => {
      if (isCurrent(request.identity)) current.current.onSuccess(result);
    },
    onError: (error, request) => {
      if (isCurrent(request.identity)) current.current.onError(error);
    },
  });
  return {
    isPending: mutation.isPending,
    mutate(input: Input) {
      if (!isCurrent(options.identity)) return;
      mutation.mutate({ input, identity: options.identity });
    },
  };
}
