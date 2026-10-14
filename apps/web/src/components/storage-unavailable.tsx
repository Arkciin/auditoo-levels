/**
 * Shown when IndexedDB cannot be opened (some private browsing modes, storage disabled).
 * Without it Relevé could not keep work safe offline, so it says so instead of half-working.
 */
export function StorageUnavailable() {
  return (
    <main className="mx-auto flex min-h-dvh max-w-app flex-col justify-center gap-3 px-6">
      <h1 className="text-2xl font-bold">Stockage indisponible</h1>
      <p className="text-muted-foreground">
        Relevé enregistre vos relevés sur cet appareil pour fonctionner sans réseau, mais votre
        navigateur bloque ce stockage. Quittez la navigation privée ou autorisez le stockage pour ce
        site, puis rechargez la page.
      </p>
    </main>
  );
}
