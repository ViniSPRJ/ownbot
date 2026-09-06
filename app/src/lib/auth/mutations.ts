import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { client } from "@/lib/client";

async function signOut() {
  await client("/api/auth/sign-out", {
    method: "POST",
    fallback: "Could not sign out",
  });
}

export function signOutMutationOptions(queryClient: QueryClient) {
  return mutationOptions({
    mutationFn: signOut,
    onSuccess: () => queryClient.clear(),
  });
}
