import { createElement as h, useEffect, useRef } from "react";

// 抽屉统一支持 Escape、焦点圈定与关闭后焦点恢复。
export function Drawer({ title, onClose, children }: any) {
  const ref = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    const root = ref.current;
    if (!root) return;
    const focusable = () =>
      Array.from(
        root.querySelectorAll<HTMLElement>(
          'button:not(:disabled),input,select,textarea,[tabindex="0"]',
        ),
      );
    focusable()[0]?.focus();
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCloseRef.current();
      }
      if (e.key === "Tab") {
        const list = focusable(),
          first = list[0],
          last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    root.addEventListener("keydown", keydown);
    return () => {
      root.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, []);
  return h(
    "div",
    {
      className: "overlay",
      onMouseDown: (e: any) => {
        if (e.target === e.currentTarget) onCloseRef.current();
      },
    },
    h(
      "section",
      {
        className: "drawer",
        role: "dialog",
        "aria-modal": true,
        "aria-label": title,
        ref,
      },
      h(
        "div",
        { className: "row between" },
        h("h2", null, title),
        h("button", { onClick: onClose, "aria-label": "关闭" }, "关闭"),
      ),
      children,
    ),
  );
}

export const fieldSelect = (
  name: string,
  value: string,
  onChange: (v: string) => void,
  options: [string, string][],
  opts: { disabled?: boolean; required?: boolean } = {},
) =>
  h(
    "label",
    null,
    name,
    h(
      "select",
      {
        value,
        required: opts.required,
        disabled: opts.disabled,
        onChange: (e: any) => onChange(e.target.value),
      },
      ...options.map(([v, t]) => h("option", { key: v, value: v }, t)),
    ),
  );

export const fieldInput = (
  name: string,
  value: string,
  onChange: (v: string) => void,
  opts: { min: number; max: number },
) =>
  h(
    "label",
    null,
    name,
    h("input", {
      "aria-label": name,
      type: "number",
      min: opts.min,
      max: opts.max,
      required: true,
      value,
      onChange: (e: any) => onChange(e.target.value),
    }),
  );

export const filterSelect = (
  name: string,
  value: string,
  onChange: (v: string) => void,
  options: [string, string][],
) =>
  h(
    "select",
    {
      key: name,
      "aria-label": name,
      value,
      onChange: (e: any) => onChange(e.target.value),
    },
    ...options.map(([v, t]) => h("option", { key: v, value: v }, t)),
  );
