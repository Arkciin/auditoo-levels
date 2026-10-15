import { act, render, screen, waitFor } from "@testing-library/react";
import { toast } from "sonner";
import { afterEach, describe, expect, it } from "vitest";
import { Drawer, DrawerContent, DrawerDescription, DrawerTitle } from "./drawer";
import { Toaster } from "./sonner";

function Screen({ sheetOpen }: { sheetOpen: boolean }) {
  return (
    <>
      <Toaster />
      <Drawer open={sheetOpen}>
        <DrawerContent>
          <DrawerTitle>Éléments supprimés</DrawerTitle>
          <DrawerDescription>Un niveau restauré revient avec ses pièces.</DrawerDescription>
        </DrawerContent>
      </Drawer>
    </>
  );
}

/** Where the toasts show: "top" or "bottom". */
function toastsPosition(): string | null {
  return document.querySelector("[data-sonner-toaster]")?.getAttribute("data-y-position") ?? null;
}

afterEach(() => {
  act(() => {
    toast.dismiss();
  });
});

describe("toasts and sheets", () => {
  it("opening a sheet dismisses the toasts on screen, but for the update offer", async () => {
    const { rerender } = render(<Screen sheetOpen={false} />);
    act(() => {
      toast("Niveau « R+1 » supprimé", { action: { label: "Annuler", onClick: () => {} } });
      toast("Une nouvelle version de Relevé est disponible.", {
        id: "app-update",
        duration: Number.POSITIVE_INFINITY,
      });
    });
    expect(await screen.findByText("Niveau « R+1 » supprimé")).toBeInTheDocument();
    expect(toastsPosition()).toBe("bottom");

    rerender(<Screen sheetOpen />);
    await waitFor(() => expect(screen.queryByText("Niveau « R+1 » supprimé")).toBeNull());
    expect(screen.getByText("Une nouvelle version de Relevé est disponible.")).toBeInTheDocument();
  });

  it("shows toasts at the top while a sheet is open, at the bottom again once it closes", async () => {
    const { rerender } = render(<Screen sheetOpen />);
    act(() => {
      toast.error("Impossible d’enregistrer la modification.");
    });
    expect(await screen.findByText("Impossible d’enregistrer la modification.")).toBeVisible();
    expect(toastsPosition()).toBe("top");

    rerender(<Screen sheetOpen={false} />);
    await waitFor(() => expect(toastsPosition()).toBe("bottom"));
    expect(screen.getByText("Impossible d’enregistrer la modification.")).toBeInTheDocument();
  });
});
