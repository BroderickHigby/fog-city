// Mouse input for the free fly camera: drag to look, wheel to change speed. Render-only:
// nothing here ever reaches the sim.

export class PointerLook {
  private dx = 0;
  private dy = 0;
  private wheel = 0;
  private dragging = false;
  private lastX = 0;
  private lastY = 0;

  constructor(el: HTMLElement) {
    el.addEventListener("pointerdown", (e) => {
      this.dragging = true;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.dx += e.clientX - this.lastX;
      this.dy += e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
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
