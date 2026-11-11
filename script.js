// Draws wavy rings around the name and bends them toward the mouse.

const canvas = document.getElementById("waves");
const ctx = canvas.getContext("2d");

const GREEN = "15, 77, 47"; // #0f4d2f as RGB, so we can vary the opacity
const OUTLINE = "8, 38, 23"; // #082617, a darker green for the magnifying glass
const RING_COUNT = 14;
const POINTS_PER_RING = 900; // high, so the small bend near the cursor stays smooth

// Only ring points inside a circle of this radius around the cursor are affected.
// CSS defines 1cm as 96 / 2.54 ≈ 37.8px.
const EFFECT_RADIUS = 1 * (96 / 2.54);
// How hard everything inside the circle is pulled toward the cursor.
// 1 = no pull; higher = stronger. 2.5 moves a point halfway out to about a sixth of the way out.
const PULL_POWER = 2.5;

// The swimmers. Each one swims clockwise along the rings, hops to a neighbouring
// line now and then, and speeds up while it's under the magnifying glass.
//   speed     = how fast it swims, in radians per second (0.25 ≈ one lap every 25 seconds)
//   startRing = which line it starts on (0 = innermost, RING_COUNT - 1 = outermost)
//   angle     = where around the rings it starts (0 = right side, Math.PI = left side)
//   hops      = whether it hops between lines (false = stays on its starting line)
function makeSwimmer({ speed, startRing, angle, draw, hops = true }) {
  return {
    speed,
    draw,
    angle,
    hops,
    boost: 1, // current speed multiplier (goes up under the magnifying glass)
    phase: 0, // drives the tail wag / flipper paddle
    lastT: null,
    fromRing: startRing, // fromRing/toRing/switchStart describe the current hop
    toRing: startRing,
    switchStart: -Infinity,
    nextSwitch: null, // when it will hop next
  };
}

const swimmers = [
  makeSwimmer({ speed: 0.25, startRing: RING_COUNT - 1, angle: 0, draw: drawFishShape }),
  makeSwimmer({ speed: 0.5, startRing: RING_COUNT - 3, angle: 0, draw: drawFishShape }),
  makeSwimmer({ speed: 0.15, startRing: 0, angle: Math.PI, draw: drawTurtleShape }),
  makeSwimmer({
    speed: 0.2,
    startRing: RING_COUNT - 1, // the outer ring...
    angle: Math.PI / 2, // starting at the bottom
    draw: drawDuckShape,
    hops: false, // ...and it never leaves it
  }),
];

// How many times faster a swimmer goes while it's under the magnifying glass.
const SWIM_BOOST = 5;

// Every so often (a random time in this range, in seconds) a swimmer hops to a
// neighbouring line, taking SWITCH_TIME seconds to glide across.
const WAIT_MIN = 1;
const WAIT_MAX = 5;
const SWITCH_TIME = 0.8;

function randomWait() {
  return WAIT_MIN + Math.random() * (WAIT_MAX - WAIT_MIN);
}

// Which line a swimmer is on at time t. Between hops this is a whole number;
// during a hop it's in between (e.g. 12.4), which the ring maths handles smoothly.
function ringAt(s, t) {
  const progress = Math.min(Math.max((t - s.switchStart) / SWITCH_TIME, 0), 1);
  const eased = progress * progress * (3 - 2 * progress); // smooth start and stop
  return s.fromRing + (s.toRing - s.fromRing) * eased;
}

// Decide whether it's time to hop, and if so pick the line just inside or outside.
function updateRing(s, t) {
  if (!s.hops) return; // this swimmer stays on its own line
  if (s.nextSwitch === null) s.nextSwitch = t + randomWait();
  if (t < s.nextSwitch) return;

  const current = s.toRing;
  let next;
  if (current === 0) next = 1; // innermost line: can only go out
  else if (current === RING_COUNT - 1) next = current - 1; // outermost: can only go in
  else next = current + (Math.random() < 0.5 ? -1 : 1);

  s.fromRing = current;
  s.toRing = next;
  s.switchStart = t;
  s.nextSwitch = t + SWITCH_TIME + randomWait(); // wait starts after it arrives
}

// Slow everything down for people who prefer reduced motion.
const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const SPEED = reducedMotion ? 0.15 : 1;

let width = 0;
let height = 0;
let size = 0; // the smaller of width and height; all ring sizes scale from this

// Where the mouse is (null when it is not over the page).
let pointer = null;

// A smoothed copy of the pointer position, plus how strongly the effect is on (0–1).
// Both ease toward their targets every frame so motion stays smooth.
const pull = { x: 0, y: 0, strength: 0 };

function resize() {
  const dpr = window.devicePixelRatio || 1;
  width = window.innerWidth;
  height = window.innerHeight;
  size = Math.min(width, height);
  canvas.width = width * dpr;
  canvas.height = height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

function updatePull() {
  if (pointer) {
    // If the effect was off, start right at the pointer instead of sliding in.
    if (pull.strength < 0.01) {
      pull.x = pointer.x;
      pull.y = pointer.y;
    }
    // Follow the pointer closely, and fade the effect in.
    pull.x += (pointer.x - pull.x) * 0.35;
    pull.y += (pointer.y - pull.y) * 0.35;
    pull.strength += (1 - pull.strength) * 0.15;
  } else {
    // Mouse left: fade the effect out where it was.
    pull.strength += (0 - pull.strength) * 0.1;
  }
}

// The point on ring i at the given angle, at time t (in seconds).
// i can be a fraction (e.g. 12.5) to get a point halfway between two rings.
function ringPoint(i, angle, t) {
  const baseRadius = size * 0.18 + i * size * 0.018;
  const waveA = size * (0.005 + i * 0.0011);
  const waveB = size * (0.0025 + i * 0.0005);

  // Two overlapping waves make the ring wobble; time makes them drift.
  const r =
    baseRadius +
    waveA * Math.sin(6 * angle + i * 0.55 + t * 0.8) +
    waveB * Math.sin(11 * angle - i * 0.8 - t * 1.3);

  return applyPull(width / 2 + r * Math.cos(angle), height / 2 + r * Math.sin(angle));
}

// Pinch everything inside the circle toward the cursor.
// A point at fraction f of the radius moves to f^power of the radius, so
// every point inside is pulled in, while the edge itself stays put
// (the lines join up smoothly at the outline).
function applyPull(x, y) {
  if (pull.strength > 0.001) {
    const dx = x - pull.x;
    const dy = y - pull.y;
    const distance = Math.hypot(dx, dy);
    if (distance < EFFECT_RADIUS) {
      const f = distance / EFFECT_RADIUS;
      const power = 1 + (PULL_POWER - 1) * pull.strength;
      const scale = Math.pow(f, power - 1); // new distance / old distance
      return { x: pull.x + dx * scale, y: pull.y + dy * scale };
    }
  }
  return { x, y };
}

function drawRings(t) {
  for (let i = 0; i < RING_COUNT; i++) {
    ctx.beginPath();
    for (let k = 0; k <= POINTS_PER_RING; k++) {
      const angle = (k / POINTS_PER_RING) * Math.PI * 2;
      const { x, y } = ringPoint(i, angle, t);

      if (k === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }

    // Inner rings are darker and thicker; outer rings fade out.
    ctx.strokeStyle = `rgba(${GREEN}, ${1 - i * 0.055})`;
    ctx.lineWidth = Math.max(0.6, 2.4 - i * 0.1);
    ctx.stroke();
  }
}

// Draws the cursor as a magnifying glass: the lens is the circle the rings
// react to, with a handle sticking out to the bottom right.
function drawMagnifier() {
  if (pull.strength < 0.01) return;
  const alpha = pull.strength; // fades in and out with the effect
  const handleAngle = Math.PI / 4; // pointing down-right

  // Faint glass tint inside the lens.
  ctx.beginPath();
  ctx.arc(pull.x, pull.y, EFFECT_RADIUS, 0, Math.PI * 2);
  ctx.fillStyle = `rgba(${GREEN}, ${0.05 * alpha})`;
  ctx.fill();

  // Lens rim.
  ctx.strokeStyle = `rgba(${OUTLINE}, ${alpha})`;
  ctx.lineWidth = 3;
  ctx.stroke();

  // Handle.
  const startX = pull.x + Math.cos(handleAngle) * (EFFECT_RADIUS + 1.5);
  const startY = pull.y + Math.sin(handleAngle) * (EFFECT_RADIUS + 1.5);
  const handleLength = EFFECT_RADIUS * 1.1;
  ctx.beginPath();
  ctx.moveTo(startX, startY);
  ctx.lineTo(
    startX + Math.cos(handleAngle) * handleLength,
    startY + Math.sin(handleAngle) * handleLength
  );
  ctx.lineWidth = 7;
  ctx.lineCap = "round";
  ctx.stroke();
  ctx.lineCap = "butt";
}

// Moves a swimmer along for this frame and draws it.
function drawSwimmer(s, t) {
  // Time since last frame (capped, so switching tabs doesn't make it jump).
  const dt = s.lastT === null ? 0 : Math.min(Math.max(t - s.lastT, 0), 0.1);
  s.lastT = t;

  updateRing(s, t);
  const ring = ringAt(s, t);

  // Where it is, and where it will be a moment later, so it faces the
  // way it's moving (including tilting toward a new line during a hop).
  const lookAhead = 0.01 / (s.speed * s.boost); // seconds to travel 0.01 radians
  const here = ringPoint(ring, s.angle, t);
  const ahead = ringPoint(ringAt(s, t + lookAhead), s.angle + 0.01, t);
  const heading = Math.atan2(ahead.y - here.y, ahead.x - here.x);

  // Is it under the magnifying glass? Ease its speed up or back down.
  const underGlass =
    pull.strength > 0.5 && Math.hypot(here.x - pull.x, here.y - pull.y) < EFFECT_RADIUS;
  const targetBoost = underGlass ? SWIM_BOOST : 1;
  s.boost += (targetBoost - s.boost) * 0.1;

  s.angle += dt * s.speed * s.boost;
  s.phase += dt * 9 * s.boost; // tail / flippers move faster when swimming faster

  ctx.save();
  ctx.translate(here.x, here.y);
  ctx.rotate(heading); // from here on, +x is the way it's swimming
  ctx.fillStyle = `rgb(${GREEN})`;
  s.draw(size * 0.045, s.phase, s, t);
  ctx.restore();
}

// A turtle seen from above: round shell, head in front, four paddling flippers.
function drawTurtleShape(length, phase) {
  const paddle = Math.sin(phase * 0.6) * 0.35; // slower strokes than the fish's tail

  // Flippers: front pair sweeps opposite to the back pair.
  const flippers = [
    { x: 0.2, y: -0.22, side: -1, swing: paddle, size: 1 },
    { x: 0.2, y: 0.22, side: 1, swing: -paddle, size: 1 },
    { x: -0.22, y: -0.18, side: -1, swing: -paddle, size: 0.7 },
    { x: -0.22, y: 0.18, side: 1, swing: paddle, size: 0.7 },
  ];
  for (const f of flippers) {
    ctx.save();
    ctx.translate(length * f.x, length * f.y);
    ctx.rotate(f.side * (0.6 + f.swing));
    ctx.beginPath();
    ctx.ellipse(0, f.side * length * 0.1 * f.size, length * 0.07 * f.size,
      length * 0.13 * f.size, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  // Tail.
  ctx.beginPath();
  ctx.moveTo(-length * 0.3, -length * 0.05);
  ctx.lineTo(-length * 0.45, 0);
  ctx.lineTo(-length * 0.3, length * 0.05);
  ctx.closePath();
  ctx.fill();

  // Head.
  ctx.beginPath();
  ctx.ellipse(length * 0.42, 0, length * 0.11, length * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();

  // Shell.
  ctx.beginPath();
  ctx.ellipse(0, 0, length * 0.34, length * 0.27, 0, 0, Math.PI * 2);
  ctx.fill();

  // Shell pattern: a ring and a few plates, in the background colour.
  ctx.strokeStyle = "#f4f1ea";
  ctx.lineWidth = Math.max(1, length * 0.025);
  ctx.beginPath();
  ctx.ellipse(0, 0, length * 0.2, length * 0.15, 0, 0, Math.PI * 2);
  ctx.moveTo(length * 0.2, 0);
  ctx.lineTo(length * 0.32, 0);
  ctx.moveTo(-length * 0.2, 0);
  ctx.lineTo(-length * 0.32, 0);
  ctx.moveTo(0, -length * 0.15);
  ctx.lineTo(0, -length * 0.26);
  ctx.moveTo(0, length * 0.15);
  ctx.lineTo(0, length * 0.26);
  ctx.stroke();

  // Eyes.
  ctx.fillStyle = "#f4f1ea";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(length * 0.46, side * length * 0.045, length * 0.022, 0, Math.PI * 2);
    ctx.fill();
  }
}

// Every FLAP_WAIT_MIN–FLAP_WAIT_MAX seconds (picked at random) the duck flaps its
// wings: FLAP_BEATS beats over FLAP_TIME seconds.
const FLAP_WAIT_MIN = 5;
const FLAP_WAIT_MAX = 10;
const FLAP_TIME = 1.2;
const FLAP_BEATS = 3;

// How far the duck's wings are spread right now: 0 = folded, 1 = fully out.
function duckWingSpread(s, t) {
  const randomFlapWait = () => FLAP_WAIT_MIN + Math.random() * (FLAP_WAIT_MAX - FLAP_WAIT_MIN);
  if (s.nextFlap === undefined) s.nextFlap = t + randomFlapWait();
  if (t >= s.nextFlap) {
    s.flapStart = s.nextFlap;
    s.nextFlap = s.flapStart + FLAP_TIME + randomFlapWait(); // wait starts after the flap
  }
  if (s.flapStart === undefined) return 0;
  const progress = (t - s.flapStart) / FLAP_TIME;
  if (progress < 0 || progress > 1) return 0;
  return Math.abs(Math.sin(Math.PI * FLAP_BEATS * progress)); // up and down, FLAP_BEATS times
}

// A duck seen from above: round body with folded wings, head and flat beak in front.
// Now and then it spreads its wings and flaps them.
function drawDuckShape(length, phase, s, t) {
  ctx.save();
  ctx.rotate(Math.sin(phase * 0.5) * 0.08); // gentle side-to-side waddle

  // Flapping wings: they swing out sideways from the shoulders, under the body.
  const spread = duckWingSpread(s, t);
  if (spread > 0.01) {
    for (const side of [-1, 1]) {
      ctx.save();
      ctx.translate(length * 0.05, side * length * 0.12); // shoulder
      ctx.rotate(side * (0.25 + 0.35 * spread)); // swept back, opening up as they spread
      ctx.beginPath();
      // A long rounded wing reaching out to the side.
      ctx.ellipse(-length * 0.08, side * length * 0.2 * spread, length * 0.14,
        length * 0.06 + length * 0.18 * spread, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  // Tail: a short point at the back.
  ctx.beginPath();
  ctx.moveTo(-length * 0.28, -length * 0.08);
  ctx.lineTo(-length * 0.42, 0);
  ctx.lineTo(-length * 0.28, length * 0.08);
  ctx.closePath();
  ctx.fill();

  // Body.
  ctx.beginPath();
  ctx.ellipse(-length * 0.02, 0, length * 0.3, length * 0.2, 0, 0, Math.PI * 2);
  ctx.fill();

  // Beak: a flat rounded bill, sticking out past the head.
  ctx.beginPath();
  ctx.ellipse(length * 0.48, 0, length * 0.09, length * 0.05, 0, 0, Math.PI * 2);
  ctx.fill();

  // Neck and head.
  ctx.beginPath();
  ctx.ellipse(length * 0.24, 0, length * 0.09, length * 0.08, 0, 0, Math.PI * 2);
  ctx.arc(length * 0.36, 0, length * 0.11, 0, Math.PI * 2);
  ctx.fill();

  // Folded wings: two curved lines along the back, in the background colour.
  ctx.strokeStyle = "#f4f1ea";
  ctx.lineWidth = Math.max(1, length * 0.025);
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(length * 0.12, side * length * 0.13);
    ctx.quadraticCurveTo(-length * 0.1, side * length * 0.17, -length * 0.25, side * length * 0.03);
    ctx.stroke();
  }
  // Line where the bill meets the head.
  ctx.beginPath();
  ctx.moveTo(length * 0.43, -length * 0.045);
  ctx.lineTo(length * 0.43, length * 0.045);
  ctx.stroke();
  ctx.lineCap = "butt";

  // Eyes.
  ctx.fillStyle = "#f4f1ea";
  for (const side of [-1, 1]) {
    ctx.beginPath();
    ctx.arc(length * 0.37, side * length * 0.065, length * 0.022, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// A small fish seen from the side, nose facing forward (+x).
function drawFishShape(length, phase) {
  const wag = Math.sin(phase) * 0.35; // tail swings side to side

  // Body: a pointed oval, nose facing forward (+x).
  ctx.beginPath();
  ctx.moveTo(length * 0.5, 0);
  ctx.quadraticCurveTo(length * 0.1, -length * 0.26, -length * 0.3, 0);
  ctx.quadraticCurveTo(length * 0.1, length * 0.26, length * 0.5, 0);
  ctx.fill();

  // Tail: a triangle behind the body that wags.
  ctx.save();
  ctx.translate(-length * 0.28, 0);
  ctx.rotate(wag);
  ctx.beginPath();
  ctx.moveTo(0, 0);
  ctx.lineTo(-length * 0.25, -length * 0.17);
  ctx.lineTo(-length * 0.25, length * 0.17);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  // Eye.
  ctx.fillStyle = "#f4f1ea";
  ctx.beginPath();
  ctx.arc(length * 0.28, -length * 0.04, length * 0.04, 0, Math.PI * 2);
  ctx.fill();
}

function frame(time) {
  const t = (time / 1000) * SPEED; // seconds, slowed down for reduced motion
  ctx.clearRect(0, 0, width, height);
  updatePull();
  drawRings(t);
  for (const s of swimmers) drawSwimmer(s, t);
  drawMagnifier();
  requestAnimationFrame(frame);
}

// Pointer events cover mouse, pen and touch.
window.addEventListener("pointermove", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
});
window.addEventListener("pointerdown", (e) => {
  pointer = { x: e.clientX, y: e.clientY };
});
document.documentElement.addEventListener("pointerleave", () => {
  pointer = null;
});
window.addEventListener("pointerup", (e) => {
  if (e.pointerType === "touch") pointer = null;
});
window.addEventListener("blur", () => {
  pointer = null;
});
window.addEventListener("resize", resize);

resize();
requestAnimationFrame(frame);
