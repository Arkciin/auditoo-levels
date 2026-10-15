import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { deferred } from "@/sync/test-support/fixtures";
import { EditableText } from "./editable-text";

type Save = (next: string) => Promise<void> | void;

/** A room name as a screen shows it: once saved, the new name comes back as the value. */
function RoomName({
  onSave,
  canSaveOnUnmount,
  editing,
  onEditingChange,
}: {
  onSave: Save;
  canSaveOnUnmount?: () => boolean;
  editing?: boolean;
  onEditingChange?: (editing: boolean) => void;
}) {
  const [name, setName] = useState("Cuisine");
  return (
    <EditableText
      value={name}
      label="Nom de la pièce"
      onSave={async (next) => {
        await onSave(next);
        setName(next);
      }}
      {...(canSaveOnUnmount ? { canSaveOnUnmount } : {})}
      {...(editing === undefined ? {} : { editing })}
      {...(onEditingChange ? { onEditingChange } : {})}
    />
  );
}

function setup(onSave: Save = vi.fn(), canSaveOnUnmount?: () => boolean) {
  const user = userEvent.setup();
  const { unmount } = render(
    <RoomName onSave={onSave} {...(canSaveOnUnmount ? { canSaveOnUnmount } : {})} />,
  );
  return { user, onSave, unmount };
}

const nameButton = (name: string) => screen.getByRole("button", { name });
const field = () => screen.getByRole("textbox", { name: "Nom de la pièce" });
const queryField = () => screen.queryByRole("textbox", { name: "Nom de la pièce" });

/** Taps the name, then replaces the whole field with `text` (user-event key syntax). */
async function rename(user: ReturnType<typeof userEvent.setup>, text: string) {
  await user.click(nameButton("Cuisine"));
  await user.clear(field());
  if (text) await user.type(field(), text);
}

describe("EditableText", () => {
  it("is named by its text alone, as is a heading around it; renaming is its description", () => {
    render(
      <h2>
        <RoomName onSave={vi.fn()} />
      </h2>,
    );

    expect(screen.getByRole("heading", { name: "Cuisine" })).toHaveTextContent(/^Cuisine$/);
    expect(nameButton("Cuisine")).toHaveAccessibleDescription("Renommer");
  });

  it("turns into a focused field, its text selected, when the name is tapped", async () => {
    const { user } = setup();

    await user.click(nameButton("Cuisine"));

    const input = field() as HTMLInputElement;
    expect(input).toHaveFocus();
    expect(input).toHaveValue("Cuisine");
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, "Cuisine".length]);
  });

  it("saves the trimmed name on Enter and closes the field", async () => {
    const { user, onSave } = setup();

    await rename(user, "  Salon  {Enter}");

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Salon");
    expect(await screen.findByRole("button", { name: "Salon" })).toBeVisible();
    expect(queryField()).not.toBeInTheDocument();
  });

  it("saves when the field loses focus", async () => {
    const { user, onSave } = setup();

    await rename(user, "Salon");
    await user.tab();

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Salon");
    expect(await screen.findByRole("button", { name: "Salon" })).toBeVisible();
  });

  it("cancels on Escape", async () => {
    const { user, onSave } = setup();

    await rename(user, "Salon{Escape}");

    expect(onSave).not.toHaveBeenCalled();
    expect(queryField()).not.toBeInTheDocument();
    expect(nameButton("Cuisine")).toBeVisible();
  });

  it("ignores an empty name", async () => {
    const { user, onSave } = setup();

    await rename(user, "   {Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(queryField()).not.toBeInTheDocument();
    expect(nameButton("Cuisine")).toBeVisible();
  });

  it("ignores an unchanged name, surrounding spaces included", async () => {
    const { user, onSave } = setup();

    await rename(user, " Cuisine {Enter}");

    expect(onSave).not.toHaveBeenCalled();
    expect(queryField()).not.toBeInTheDocument();
  });

  it("keeps the field open and focused, with what was typed, when the save is rejected", async () => {
    // The caller reports the problem (a toast) and rejects: the user can fix the name.
    const onSave = vi.fn<Save>().mockRejectedValueOnce(new Error("not saved"));
    const { user } = setup(onSave);

    await rename(user, "Salon{Enter}");

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Salon");
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("Salon");

    await user.type(field(), " bleu{Enter}");
    expect(onSave).toHaveBeenLastCalledWith("Salon bleu");
    expect(await screen.findByRole("button", { name: "Salon bleu" })).toBeVisible();
  });

  it("takes the focus back when a save on leaving the field is rejected", async () => {
    const onSave = vi.fn<Save>().mockRejectedValueOnce(new Error("not saved"));
    const { user } = setup(onSave);

    await rename(user, "Salon");
    await user.tab();

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Salon");
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue("Salon");
  });

  it("saves once when the field loses focus while Enter is still saving", async () => {
    const saving = deferred();
    const onSave = vi.fn<Save>(() => saving.promise);
    const { user } = setup(onSave);

    await rename(user, "Salon{Enter}");
    await user.tab();
    saving.resolve();

    expect(await screen.findByRole("button", { name: "Salon" })).toBeVisible();
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("saves what was typed when the field goes away unsaved, with its screen or row", async () => {
    // The back button: the screen unmounts, and an unmount does not blur.
    const canSaveOnUnmount = vi.fn(() => true);
    const { user, onSave, unmount } = setup(vi.fn(), canSaveOnUnmount);

    await rename(user, " Cuisine ouverte ");
    unmount();

    expect(canSaveOnUnmount).toHaveBeenCalledOnce();
    expect(onSave).toHaveBeenCalledExactlyOnceWith("Cuisine ouverte");
  });

  it("drops what was typed when the field goes away, if it may no longer be saved", async () => {
    // Deleted meanwhile, or its level: the save would bring them back (edit wins over delete).
    for (const canSaveOnUnmount of [() => false, undefined]) {
      const { user, onSave, unmount } = setup(vi.fn(), canSaveOnUnmount);

      await rename(user, "Cuisine ouverte");
      unmount();

      expect(onSave).not.toHaveBeenCalled();
    }
  });

  it("saves nothing as it goes away after Escape, nor what Enter is still saving", async () => {
    const cancelled = setup(vi.fn(), () => true);
    await rename(cancelled.user, "Salon{Escape}");
    cancelled.unmount();
    expect(cancelled.onSave).not.toHaveBeenCalled();

    const saving = deferred();
    const entered = setup(
      vi.fn<Save>(() => saving.promise),
      () => true,
    );
    await rename(entered.user, "Salon{Enter}");
    entered.unmount();
    saving.resolve();
    expect(entered.onSave).toHaveBeenCalledExactlyOnceWith("Salon");
  });

  it("gives the focus back to the name once saved with Enter, or cancelled with Escape", async () => {
    const { user } = setup();

    await rename(user, "Salon{Enter}");
    expect(await screen.findByRole("button", { name: "Salon" })).toHaveFocus();

    await user.keyboard("{Enter}"); // the name, focused, opens the field again
    expect(field()).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(nameButton("Salon")).toHaveFocus();
  });

  it("gives the focus back to the name when the field is left for no other control", async () => {
    const { user } = setup();

    await rename(user, "Salon");
    await user.click(document.body); // a tap beside the controls

    expect(await screen.findByRole("button", { name: "Salon" })).toHaveFocus();
  });

  it("leaves the focus on the control the field was left for", async () => {
    const user = userEvent.setup();
    render(
      <>
        <RoomName onSave={vi.fn()} />
        <button type="button">Suivant</button>
      </>,
    );

    await rename(user, "Salon");
    await user.tab();

    expect(await screen.findByRole("button", { name: "Salon" })).not.toHaveFocus();
    expect(screen.getByRole("button", { name: "Suivant" })).toHaveFocus();
  });

  it("can be opened from outside, e.g. by a « Renommer » menu item", async () => {
    const user = userEvent.setup();
    const onEditingChange = vi.fn();
    const onSave = vi.fn();
    function Controlled() {
      const [editing, setEditing] = useState(true);
      return (
        <RoomName
          onSave={onSave}
          editing={editing}
          onEditingChange={(next) => {
            onEditingChange(next);
            setEditing(next);
          }}
        />
      );
    }
    render(<Controlled />);

    expect(field()).toHaveFocus();
    await user.type(field(), "{Control>}a{/Control}Salon{Enter}");

    expect(onSave).toHaveBeenCalledExactlyOnceWith("Salon");
    expect(onEditingChange).toHaveBeenLastCalledWith(false);
    expect(await screen.findByRole("button", { name: "Salon" })).toBeVisible();
  });
});
