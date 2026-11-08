// The caller retains the rejecting operation; the queue tail must still admit
// later work. This promise is only an ordering barrier, never a result.
export async function settled(work: Promise<unknown>): Promise<void> {
  await Promise.allSettled([work]);
}
