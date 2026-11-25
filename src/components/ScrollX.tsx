"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Wide-table wrapper with a horizontal scrollbar above the table as well as
 * below it (kept in sync), both always visible, so wide reports can be
 * scrolled sideways without first scrolling to the bottom.
 */
export function ScrollX({ children, className = "" }: { children: ReactNode; className?: string }) {
  const top = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const el = body.current;
    if (!el) return;
    const measure = () => {
      setWidth(el.scrollWidth);
      setOverflow(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const sync = (from: "top" | "body") => {
    const a = from === "top" ? top.current : body.current;
    const b = from === "top" ? body.current : top.current;
    if (a && b && b.scrollLeft !== a.scrollLeft) b.scrollLeft = a.scrollLeft;
  };

  return (
    <div>
      {overflow && (
        <div ref={top} onScroll={() => sync("top")} className="scrollbar-visible mb-1 overflow-x-scroll overflow-y-hidden" aria-hidden data-testid="scroll-top">
          <div style={{ width, height: 1 }} />
        </div>
      )}
      <div ref={body} onScroll={() => sync("body")} className={`scrollbar-visible overflow-auto ${className}`}>
        {children}
      </div>
    </div>
  );
}
