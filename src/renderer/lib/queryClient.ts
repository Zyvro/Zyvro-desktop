import { QueryClient } from "@tanstack/react-query"

// A module-level instance, as the project's doctrine requires: a QueryClient
// built inside a component is recreated on every render and silently empties
// its own cache. Keeping it here also lets code outside the React tree — the
// menu bridge, the router shims — read and invalidate the same cache.
//
// Retries are off. Every request is a loopback call to a daemon this process
// supervises, so a failure means something is actually wrong and should be
// visible now rather than after four backoffs.
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: false, refetchOnWindowFocus: false, staleTime: 2000 },
  },
})
