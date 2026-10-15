import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useHeldWhileClosing, useOpenedOnce } from "./drawer";

function Sheet({ open }: { open: boolean }) {
  return useOpenedOnce(open) ? <p>{open ? "Ouverte" : "Fermée"}</p> : null;
}

describe("useOpenedOnce", () => {
  it("mounts a sheet on its first opening, and keeps it once closed so that it slides out", () => {
    const { rerender } = render(<Sheet open={false} />);
    expect(screen.queryByText(/Ouverte|Fermée/)).toBeNull();

    rerender(<Sheet open />);
    expect(screen.getByText("Ouverte")).toBeInTheDocument();

    rerender(<Sheet open={false} />);
    expect(screen.getByText("Fermée")).toBeInTheDocument();
  });

  it("mounts a sheet open from the start", () => {
    render(<Sheet open />);
    expect(screen.getByText("Ouverte")).toBeInTheDocument();
  });
});

function Content({ value, open }: { value: string; open: boolean }) {
  return <p>{useHeldWhileClosing(value, open)}</p>;
}

describe("useHeldWhileClosing", () => {
  it("follows the value while open, and holds the last one while closing", () => {
    const { rerender } = render(<Content value="3 logements" open />);
    rerender(<Content value="2 logements" open />);
    expect(screen.getByText("2 logements")).toBeInTheDocument();

    rerender(<Content value="1 logement" open={false} />);
    expect(screen.getByText("2 logements")).toBeInTheDocument();
  });
});
