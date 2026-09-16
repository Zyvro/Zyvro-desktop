import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import type { Account } from "../../preload"

// The renderer only ever learns who is signed in, never how. The credential
// stays in the main process, which is the part of the app that does not render
// model output or workflow content.

export const accountKey = ["account", "current"] as const

export function useAccount() {
  return useQuery({
    queryKey: accountKey,
    queryFn: (): Promise<Account | null> => window.zyvro.account.current(),
    staleTime: 60_000,
  })
}

export function useSignIn() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: ({ email, password }: { email: string; password: string }) =>
      window.zyvro.account.signIn(email, password),
    onSuccess: (account) => client.setQueryData(accountKey, account),
  })
}

export function useSignOut() {
  const client = useQueryClient()
  return useMutation({
    mutationFn: () => window.zyvro.account.signOut(),
    onSuccess: () => client.setQueryData(accountKey, null),
  })
}
