/** Round a proof's computed point to the integer pixels the computer wire requires. */
export function intPoint(x: number, y: number): [number, number] {
  return [Math.round(x), Math.round(y)]
}
