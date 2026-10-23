// Mouse and touch drag on the game view: in the free fly camera drag looks and the wheel sets the
// speed; in the chase camera drag orbits round the player (click-hold-drag, or one finger on the
// view on a phone). Render-only: nothing here ever reaches the sim. One pointer drags at a time,
// so a thumb on the touch stick (its own element) never fights a finger on the view.

export class PointerLook {
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;
  private pointerId = -1;

  constructor(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      if (this.dragging) return;
      this.dragging = true;
      this.pointerId = e.pointerId;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging || e.pointerId !== this.pointerId) return;
      this.dx += e.clientX - this.lastX;
      this.dy += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const end = (e: PointerEvent): void => {
      if (e.pointerId !== this.pointerId) return;
      this.dragging = false;
      this.pointerId = -1;
      el.releasePointerCapture?.(e.pointerId);
    };
    el.addEventListener("pointerup", end);
    el.addEventListener("pointercancel", end);
    el.addEventListener(
      "wheel",
      (e) => {
        this.wheel += Math.sign(e.deltaY);
        e.preventDefault();
      },
      { passive: false },
    );
  }

  /** Pixels dragged since the last call. */
  takeDrag(out: { x: number; y: number }): { x: number; y: number } {
    out.x = this.dx;
    out.y = this.dy;
    this.dx = 0;
    this.dy = 0;
    return out;
  }

  /** Wheel notches since the last call (+ = scrolled down). */
  takeWheel(): number {
    const w = this.wheel;
    this.wheel = 0;
    return w;
  }
}
