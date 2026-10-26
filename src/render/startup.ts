/** Keep the first view covered until its streets have reached the actual draw loop. */
export async function prepareStartingStreets(options: {
  render: () => void;
  ready: () => boolean;
  nextFrame?: () => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
}): Promise<void> {
  const now = options.now ?? (() => performance.now());
  const nextFrame = options.nextFrame ?? (() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const deadline = now() + (options.timeoutMs ?? 45_000);
  let stableFrames = 0;
  for (;;) {
    options.render();
    stableFrames = options.ready() ? stableFrames + 1 : 0;
    if (stableFrames >= 2) return;
    if (now() >= deadline) throw new Error("Starting streets did not finish loading. Reload to try again.");
    await nextFrame();
  }
}
