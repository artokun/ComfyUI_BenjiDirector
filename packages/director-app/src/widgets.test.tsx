// @vitest-environment jsdom
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RangeControl, Select, Stepper, Toggle, clampStep } from "./widgets.jsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounted: { root: Root; host: HTMLElement }[] = [];
function mount(el: ReactElement): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  act(() => root.render(el));
  mounted.push({ root, host });
  return host;
}
afterEach(() => {
  for (const { root, host } of mounted) {
    act(() => root.unmount());
    host.remove();
  }
  mounted = [];
});

const q = <T extends Element = HTMLElement>(host: HTMLElement, sel: string): T => {
  const el = host.querySelector<T>(sel);
  if (!el) throw new Error(`no ${sel}`);
  return el;
};
const click = (el: Element) => act(() => void el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })));
// jsdom has no PointerEvent; React dispatches on the event NAME, so a MouseEvent wearing it works.
const pointer = (el: Element, type: string, init: MouseEventInit) => act(() => void el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...init })));
const key = (el: Element, k: string) => act(() => void el.dispatchEvent(new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true })));
const typeInto = (input: HTMLInputElement, v: string) =>
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, v);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
const trackAt = (host: HTMLElement, left: number, width: number) => {
  const track = q(host, ".bd-range-track");
  track.getBoundingClientRect = () => ({ left, width, right: left + width, top: 0, bottom: 20, height: 20, x: left, y: 0, toJSON: () => ({}) }) as DOMRect;
  return track;
};

describe("clampStep", () => {
  it("snaps to the step grid anchored at min, then clamps", () => {
    expect(clampStep(5, 1, 60)).toBe(5);
    expect(clampStep(0, 1, 60)).toBe(1);
    expect(clampStep(99, 1, 60)).toBe(60);
    expect(clampStep(5.3, 1, 60, 0.5)).toBe(5.5);
    expect(clampStep(5.2, 1, 60, 0.5)).toBe(5);
  });
  it("trims float noise to the step's precision", () => {
    expect(clampStep(0.1 + 0.2, 0, 1, 0.1)).toBe(0.3);
    expect(clampStep(0.35, 0, 1, 0.1)).toBe(0.4);
  });
  it("refuses NaN, Infinity and a zero step", () => {
    expect(clampStep(Number.NaN, 1, 60)).toBe(1);
    expect(clampStep(Number.POSITIVE_INFINITY, 1, 60)).toBe(1);
    expect(clampStep(7.4, 1, 60, 0)).toBe(7);
  });
});

describe("RangeControl", () => {
  it("steps by ± and clamps at the bounds", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={5} min={1} max={60} onChange={onChange} />);
    click(q(host, '[aria-label="increase"]'));
    expect(onChange).toHaveBeenLastCalledWith(6, false);
    click(q(host, '[aria-label="decrease"]'));
    expect(onChange).toHaveBeenLastCalledWith(4, false);

    const atMax = vi.fn();
    const top = mount(<RangeControl value={60} min={1} max={60} onChange={atMax} />);
    click(q(top, '[aria-label="increase"]'));
    expect(atMax).not.toHaveBeenCalled();
  });

  it("shows the value with its suffix and fills the track proportionally", () => {
    const host = mount(<RangeControl value={30} min={0} max={100} suffix="s" onChange={() => {}} />);
    expect(q(host, ".bd-range-val").textContent).toBe("30s");
    expect(q(host, ".bd-range-fill").style.width).toBe("30%");
    expect(q(host, ".bd-range-track").getAttribute("aria-valuenow")).toBe("30");
  });

  it("click the value to type, Enter commits it clamped", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={5} min={1} max={60} onChange={onChange} />);
    click(q(host, ".bd-range-val"));
    const input = q<HTMLInputElement>(host, "input.bd-range-edit");
    expect(input.value).toBe("5");
    typeInto(input, "999");
    key(input, "Enter");
    expect(onChange).toHaveBeenLastCalledWith(60, false);
    expect(host.querySelector("input.bd-range-edit")).toBeNull();
  });

  it("Escape cancels the typed value", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={5} min={1} max={60} onChange={onChange} />);
    click(q(host, ".bd-range-val"));
    typeInto(q<HTMLInputElement>(host, "input.bd-range-edit"), "12");
    key(q(host, "input.bd-range-edit"), "Escape");
    expect(onChange).not.toHaveBeenCalled();
    expect(host.querySelector("input.bd-range-edit")).toBeNull();
  });

  // Escape UNMOUNTS the input, so React fires no blur and the commit path never runs. A
  // "cancelled" flag cleared only on commit therefore survives, and eats the next real value.
  it("an Escape does not swallow the NEXT value typed", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={5} min={1} max={60} onChange={onChange} />);
    click(q(host, ".bd-range-val"));
    typeInto(q<HTMLInputElement>(host, "input.bd-range-edit"), "12");
    key(q(host, "input.bd-range-edit"), "Escape");

    click(q(host, ".bd-range-val"));
    typeInto(q<HTMLInputElement>(host, "input.bd-range-edit"), "20");
    key(q(host, "input.bd-range-edit"), "Enter");
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenLastCalledWith(20, false);
  });

  it("an empty or unparseable entry commits nothing", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={5} min={1} max={60} onChange={onChange} />);
    click(q(host, ".bd-range-val"));
    typeInto(q<HTMLInputElement>(host, "input.bd-range-edit"), "");
    key(q(host, "input.bd-range-edit"), "Enter");
    expect(onChange).not.toHaveBeenCalled();

    click(q(host, ".bd-range-val"));
    typeInto(q<HTMLInputElement>(host, "input.bd-range-edit"), "  ");
    key(q(host, "input.bd-range-edit"), "Enter");
    expect(onChange).not.toHaveBeenCalled();
  });

  it("the ± buttons move by stepBy when the drag snaps finer", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={10} min={1} max={60} step={0.5} stepBy={1} onChange={onChange} />);
    click(q(host, '[aria-label="increase"]'));
    expect(onChange).toHaveBeenLastCalledWith(11, false);
    click(q(host, '[aria-label="decrease"]'));
    expect(onChange).toHaveBeenLastCalledWith(9, false);
  });

  it("drags anywhere on the track: live values while the button is down, one commit at the end", () => {
    const onChange = vi.fn();
    const onCommit = vi.fn();
    const host = mount(<RangeControl value={0} min={0} max={100} onChange={onChange} onCommit={onCommit} />);
    const track = trackAt(host, 0, 100);
    pointer(track, "pointerdown", { clientX: 50, button: 0, buttons: 1 });
    expect(onChange).toHaveBeenLastCalledWith(50, true);
    pointer(track, "pointermove", { clientX: 75, buttons: 1 });
    expect(onChange).toHaveBeenLastCalledWith(75, true);
    pointer(track, "pointermove", { clientX: 500, buttons: 1 });
    expect(onChange).toHaveBeenLastCalledWith(100, true);
    expect(onCommit).not.toHaveBeenCalled();
    pointer(track, "pointerup", { clientX: 500, button: 0, buttons: 0 });
    expect(onCommit).toHaveBeenCalledTimes(1);
    // The drag is over: moving without a button held changes nothing.
    pointer(track, "pointermove", { clientX: 10, buttons: 0 });
    expect(onChange).toHaveBeenLastCalledWith(100, true);
  });

  it("snaps a dragged position to the step", () => {
    const onChange = vi.fn();
    const host = mount(<RangeControl value={1} min={1} max={60} step={0.5} onChange={onChange} />);
    const track = trackAt(host, 0, 100);
    pointer(track, "pointerdown", { clientX: 33, button: 0, buttons: 1 });
    // 1 + 0.33 * 59 = 20.47 → 20.5 on the half-second grid
    expect(onChange).toHaveBeenLastCalledWith(20.5, true);
  });

  it("does not let its pointer-down reach the node", () => {
    const outer = vi.fn();
    const host = mount(
      <div onPointerDown={outer}>
        <RangeControl value={5} min={1} max={60} onChange={() => {}} />
      </div>,
    );
    pointer(q(host, ".bd-range-track"), "pointerdown", { clientX: 10, button: 0, buttons: 1 });
    pointer(q(host, ".bd-range-val"), "pointerdown", { clientX: 10, button: 0, buttons: 1 });
    expect(outer).not.toHaveBeenCalled();
  });
});

describe("Toggle", () => {
  it("flips and reports its state", () => {
    const onChange = vi.fn();
    const host = mount(<Toggle value={false} onChange={onChange} label="mute" />);
    const sw = q(host, '[role="switch"]');
    expect(sw.getAttribute("aria-checked")).toBe("false");
    click(sw);
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("Stepper", () => {
  it("emits clamped values and greys out at the bounds", () => {
    const onChange = vi.fn();
    const host = mount(<Stepper value={59.5} min={1} max={60} step={0.5} suffix="s" onChange={onChange} />);
    expect(q(host, ".bd-stepper-val").textContent).toBe("59.5s");
    click(q(host, '[aria-label="increase"]'));
    expect(onChange).toHaveBeenLastCalledWith(60);
    const top = mount(<Stepper value={60} min={1} max={60} onChange={onChange} />);
    expect(q<HTMLButtonElement>(top, '[aria-label="increase"]').disabled).toBe(true);
    expect(q<HTMLButtonElement>(top, '[aria-label="decrease"]').disabled).toBe(false);
  });
});

describe("Select", () => {
  it("reports the picked option", () => {
    const onChange = vi.fn();
    const host = mount(
      <Select
        value="a"
        options={[
          { value: "a", label: "A" },
          { value: "b", label: "B" },
        ]}
        onChange={onChange}
      />,
    );
    const sel = q<HTMLSelectElement>(host, "select");
    act(() => {
      sel.value = "b";
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onChange).toHaveBeenCalledWith("b");
  });
});
