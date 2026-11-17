export type Point = { x: number; y: number }
export type Camera = Point & { scale: number }
export type Frame = { left: number; top: number; width: number; height: number }
export type Box = { x: number; y: number; width: number; height: number }

// Adapted from the reference viewer's frameDesktop: fit the union of the
// semantic nodes in a padded frame, then translate its midpoint into view.
// Plate's frame is measured from the canvas and excludes the floating card.
export function frameNodes(boxes: Box[], frame: Frame, minScale: number, maxScale: number): Camera {
  let left=Infinity, top=Infinity, right=-Infinity, bottom=-Infinity
  for (const box of boxes) {
    left=Math.min(left,box.x); right=Math.max(right,box.x+box.width)
    top=Math.min(top,box.y); bottom=Math.max(bottom,box.y+box.height)
  }
  const fitted=Math.min(frame.width/Math.max(1,right-left),frame.height/Math.max(1,bottom-top))*.9
  const scale=Math.min(maxScale,Math.max(minScale,fitted))
  return {scale, x:frame.left+frame.width/2-(left+right)/2*scale,
    y:frame.top+frame.height/2-(top+bottom)/2*scale}
}

// Same ease-out used by the reference viewer's camera transaction.
export function interpolateCamera(from: Camera, to: Camera, fraction: number): Camera {
  const t=1-(1-fraction)**3
  return {x:from.x+(to.x-from.x)*t,y:from.y+(to.y-from.y)*t,scale:from.scale+(to.scale-from.scale)*t}
}
