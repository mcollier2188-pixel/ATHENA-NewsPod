export interface GamepadFrameState {
  connected: boolean;
  label: string;
  leftX: number;
  leftY: number;
  rightX: number;
  rightY: number;
  lt: number;
  rt: number;
  aJustPressed: boolean;
  bJustPressed: boolean;
  xJustPressed: boolean;
  yJustPressed: boolean;
  lbJustPressed: boolean;
  rbJustPressed: boolean;
  dpadLeftJustPressed: boolean;
  dpadRightJustPressed: boolean;
}

const DEADZONE = 0.12; // Deterministic 12% Hall-Effect analog deadzone clamp

function clampRadialStick(
  rawX: number,
  rawY: number,
  out: [number, number]
): void {
  const mag = Math.hypot(rawX, rawY);
  if (mag < DEADZONE) {
    out[0] = 0;
    out[1] = 0;
    return;
  }
  const scaled = Math.min(1, (mag - DEADZONE) / (1 - DEADZONE));
  const inv = scaled / mag;
  out[0] = rawX * inv;
  out[1] = rawY * inv;
}

/**
 * Zero-allocation 60 FPS Gamepad poller supporting standard W3C / Hall-Effect USB
 * controllers (GameSir G7 SE, Xbox, DualSense) for 3D Stage Orbit/UV & Dispatch Run 3D.
 */
export class GamepadPoller {
  private prevButtons = new Uint8Array(18);
  private stickTmp: [number, number] = [0, 0];

  private state: GamepadFrameState = {
    connected: false,
    label: '',
    leftX: 0,
    leftY: 0,
    rightX: 0,
    rightY: 0,
    lt: 0,
    rt: 0,
    aJustPressed: false,
    bJustPressed: false,
    xJustPressed: false,
    yJustPressed: false,
    lbJustPressed: false,
    rbJustPressed: false,
    dpadLeftJustPressed: false,
    dpadRightJustPressed: false,
  };

  poll(): GamepadFrameState {
    const s = this.state;
    s.aJustPressed = false;
    s.bJustPressed = false;
    s.xJustPressed = false;
    s.yJustPressed = false;
    s.lbJustPressed = false;
    s.rbJustPressed = false;
    s.dpadLeftJustPressed = false;
    s.dpadRightJustPressed = false;

    if (
      typeof navigator === 'undefined' ||
      typeof navigator.getGamepads !== 'function'
    ) {
      s.connected = false;
      s.leftX = 0;
      s.leftY = 0;
      s.rightX = 0;
      s.rightY = 0;
      s.lt = 0;
      s.rt = 0;
      return s;
    }

    const pads = navigator.getGamepads();
    let pad: Gamepad | null = null;
    for (let i = 0; i < pads.length; i++) {
      const candidate = pads[i];
      if (candidate && candidate.connected) {
        pad = candidate;
        break;
      }
    }

    if (!pad) {
      s.connected = false;
      s.label = '';
      s.leftX = 0;
      s.leftY = 0;
      s.rightX = 0;
      s.rightY = 0;
      s.lt = 0;
      s.rt = 0;
      this.prevButtons.fill(0);
      return s;
    }

    s.connected = true;
    s.label = pad.id.split('(')[0].trim().slice(0, 28) || 'USB Controller';

    clampRadialStick(pad.axes[0] ?? 0, pad.axes[1] ?? 0, this.stickTmp);
    s.leftX = this.stickTmp[0];
    s.leftY = this.stickTmp[1];

    clampRadialStick(pad.axes[2] ?? 0, pad.axes[3] ?? 0, this.stickTmp);
    s.rightX = this.stickTmp[0];
    s.rightY = this.stickTmp[1];

    const btn = pad.buttons;
    s.lt = btn[6]?.value ?? 0;
    s.rt = btn[7]?.value ?? 0;

    const edge = (idx: number): boolean => {
      const pressed = btn[idx]?.pressed ? 1 : 0;
      const wasPressed = this.prevButtons[idx] === 1;
      this.prevButtons[idx] = pressed;
      return pressed === 1 && !wasPressed;
    };

    s.aJustPressed = edge(0);
    s.bJustPressed = edge(1);
    s.xJustPressed = edge(2);
    s.yJustPressed = edge(3);
    s.lbJustPressed = edge(4);
    s.rbJustPressed = edge(5);
    s.dpadLeftJustPressed = edge(14);
    s.dpadRightJustPressed = edge(15);

    return s;
  }
}
