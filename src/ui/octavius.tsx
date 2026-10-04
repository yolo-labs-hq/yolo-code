import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";

export type OctaviusPose =
  | "default"
  | "armsUp"
  | "lookLeft"
  | "lookRight"
  | "lookDown"
  | "loading";

interface Props {
  pose?: OctaviusPose;
  /** Body color. Defaults to YOLO orange. */
  color?: string;
  /** Freeze animation (tests / YOLO_CODE_QUIET_UI). */
  still?: boolean;
}

const ORANGE = "#ff6b35";

// [leftArm, eyeZone(5 chars), rightArm] — matches the rust/chalk reference art.
const POSES: Record<string, [string, string, string]> = {
  default:   ["█▄█", "▀ █▀ ", "█▄█"],
  armsUp:    ["█▀█", "▀ █▀ ", "█▀█"],
  lookLeft:  ["█▄█", "▀ █ ▀", "█▄█"],
  lookRight: ["█▄█", " ▀█ ▀", "█▄█"],
  lookDown:  ["█▄█", "▄ █▄ ", "█▄█"],
};

// Quarter-blocks used for the loading spin.
const QUARTERS = ["▘", "▝", "▗", "▖"] as const;
const CW  = [0, 1, 2, 3] as const;
const CCW = [1, 0, 3, 2] as const;

// Chars the reference treats as eyeball highlights (white on black).
const EYEBALL_CHARS = new Set(["▘", "▝", "▀", "▄", "▖"]);

// Idle googly: each eye has a 2-cell lens, so we get clean left/right
// glances by shifting the highlight position inside the lens. Frame 0
// puts both pupils at the outer half of their lens, frame 1 at the
// inner half — alternating reads as "eyes scanning left to right".
const IDLE_FRAMES: readonly string[] = [
  "▀ █▀ ", // both pupils slid left
  " ▀█ ▀", // both pupils slid right
];

/** Set YOLO_CODE_QUIET_UI=1 to freeze all animation (xterm.js external-scroll
 *  containers can thrash on every Ink commit). */
export function quietUiEnabled(): boolean {
  const v = process.env.YOLO_CODE_QUIET_UI;
  return v === "1" || v === "true" || v === "yes";
}

// --- sub-components ---

function EyeZone({ chars }: { chars: string }) {
  return (
    <>
      {[...chars].map((ch, i) => {
        const isEye = EYEBALL_CHARS.has(ch);
        return (
          <Text key={i} color={isEye ? "white" : ORANGE} backgroundColor="black" bold>
            {ch}
          </Text>
        );
      })}
    </>
  );
}

function LoadingEyeZone({ frame }: { frame: number }) {
  const step = (frame) % 4;
  const prev = (step + 3) % 4;
  const entries = [
    { ch: QUARTERS[CW[prev]!]!,  color: "#6e6e73" },
    { ch: QUARTERS[CW[step]!]!,  color: "white"   },
    { ch: "█",                    color: ORANGE     },
    { ch: QUARTERS[CCW[step]!]!, color: "white"   },
    { ch: QUARTERS[CCW[prev]!]!, color: "#6e6e73" },
  ];
  return (
    <>
      {entries.map(({ ch, color }, i) => (
        <Text key={i} color={color} backgroundColor="black" bold>
          {ch}
        </Text>
      ))}
    </>
  );
}

// --- main component ---

export function Octavius({ pose = "default", color = ORANGE, still }: Props) {
  const frozen = still || quietUiEnabled();
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (frozen) return;
    if (pose === "loading") {
      const id = setInterval(() => setFrame((f) => (f + 1) % 4), 250);
      return () => clearInterval(id);
    }
    // Idle: alternate the eye row between IDLE_FRAMES at 1500 ms.
    const id = setInterval(() => setFrame((f) => f + 1), 1500);
    return () => clearInterval(id);
  }, [pose, frozen]);

  const [r2l, baseEye, r2r] = POSES[pose] ?? POSES["default"]!;
  const animatedIdle = !frozen && (pose === "default" || pose === "armsUp");
  const r2e = animatedIdle ? IDLE_FRAMES[frame % IDLE_FRAMES.length]! : baseEye;

  return (
    <Box flexDirection="column">
      <Text bold color={color}>{"  ▄█████▄  "}</Text>
      <Box>
        <Text bold color={color}>{r2l}</Text>
        {pose === "loading" ? (
          <LoadingEyeZone frame={frame} />
        ) : (
          <EyeZone chars={r2e} />
        )}
        <Text bold color={color}>{r2r}</Text>
      </Box>
      <Text bold color={color}>{" ████████  "}</Text>
      <Text bold color={color}>{"  ▀█▀█▀█▀  "}</Text>
    </Box>
  );
}
