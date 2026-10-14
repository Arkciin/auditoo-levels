import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useOpenedOnce } from "./drawer";

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
