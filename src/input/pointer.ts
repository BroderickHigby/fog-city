// Mouse look shared by fly camera and on-foot aim. The caller records gameplay aim.

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
      if(e.button===2 && el.requestPointerLock){try{const request=el.requestPointerLock();if(request)void request.catch(()=>{});}catch{/* Drag aiming remains available. */}}
      this.lastX = e.clientX;
      this.lastY = e.clientY;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener("pointermove", (e) => {
      if (!this.dragging) return;
      this.dx += document.pointerLockElement === el ? e.movementX : e.clientX - this.lastX;
      this.dy += document.pointerLockElement === el ? e.movementY : e.clientY - this.lastY;
      this.lastX = e.clientX;
      this.lastY = e.clientY;
    });
    const end = (e: PointerEvent): void => {
      this.dragging = false;
      if(document.pointerLockElement===el)document.exitPointerLock();
      el.releasePointerCapture?.(e.pointerId);
    };
    window.addEventListener("blur", () => { this.dragging = false; this.dx = this.dy = 0; });
    document.addEventListener("pointerlockchange", () => {
      if (document.pointerLockElement !== el) this.dragging = false;
    });
    el.addEventListener("contextmenu",e=>e.preventDefault());
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
