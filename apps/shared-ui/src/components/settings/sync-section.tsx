import { PASSPHRASE_MIN_LENGTH as MIN_PASSPHRASE } from "@/lib/sync/protocol";
import { useState, type FormEvent } from "react";
import { useSelector } from "@tanstack/react-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DEFAULT_SYNC_SERVER,
  startSignIn,
  unlockKey,
  getKeyInfo,
  verifySignIn,
} from "@/lib/sync/account";
import {
  deleteCloudData,
  disableSync,
  enableSync,
  retrySync,
  syncStatusStore,
  type SyncUiStatus,
} from "@/lib/sync/manager";



type Step =
  | { kind: "email" }
  | { kind: "code"; email: string }
  | { kind: "passphrase"; email: string; userId: string; token: string; isNew: boolean };

const formatTime = (ms: number) =>
  new Date(ms).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });

function describe(status: SyncUiStatus) {
  switch (status.state) {
    case "synced":
      return status.lastSyncedAt ? `Up to date as of ${formatTime(status.lastSyncedAt)}.` : "Up to date";
    case "syncing":
    case "connecting":
      return "Syncing…";
    case "offline":
      return "Offline. Changes are kept on this device and sync when you're back online.";
    case "error":
      return status.error ?? "Sync stopped.";
    default:
      return "Not running.";
  }
}

const SignIn = () => {
  const [server, setServer] = useState(DEFAULT_SYNC_SERVER);
  const [step, setStep] = useState<Step>({ kind: "email" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);

  async function attempt(task: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try {
      await task();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (busy) return;
    if (step.kind === "email") {
      void attempt(async () => {
        const result = await startSignIn(server, email.trim());
        setDevCode(result.devCode ?? null);
        setStep({ kind: "code", email: email.trim() });
      });
    } else if (step.kind === "code") {
      void attempt(async () => {
        const session = await verifySignIn(server, step.email, code.trim());
        const info = await getKeyInfo(server, session.token);
        setStep({ kind: "passphrase", email: session.email, userId: session.userId, token: session.token, isNew: !info });
      });
    } else {
      if (step.isNew && passphrase.length < MIN_PASSPHRASE) {
        setError(`Use at least ${MIN_PASSPHRASE} characters.`);
        return;
      }
      if (step.isNew && passphrase !== confirm) {
        setError("The passphrases don't match.");
        return;
      }
      void attempt(async () => {
        const key = await unlockKey(server, step.token, passphrase);
        await enableSync({ server, email: step.email, userId: step.userId, token: step.token, key });
      });
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-3 rounded-lg bg-muted/50 p-3">
      {step.kind === "email" && (
        <>
          {import.meta.env.DEV && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-server">Server (development)</Label>
              <Input id="sync-server" value={server} onChange={(event) => setServer(event.target.value)} />
            </div>
          )}
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-email">Email</Label>
            <Input
              id="sync-email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <p className="text-sm text-muted-foreground">We'll email you a 6-digit code. No password needed.</p>
        </>
      )}

      {step.kind === "code" && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="sync-code">Code sent to {step.email}</Label>
          <Input
            id="sync-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            required
            autoFocus
            value={code}
            onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))}
          />
          {devCode && <p className="text-sm text-muted-foreground">Development code: {devCode}</p>}
        </div>
      )}

      {step.kind === "passphrase" && (
        <>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="sync-passphrase">
              {step.isNew ? "Create a sync passphrase" : "Sync passphrase"}
            </Label>
            <Input
              id="sync-passphrase"
              type="password"
              autoComplete={step.isNew ? "new-password" : "current-password"}
              required
              autoFocus
              value={passphrase}
              onChange={(event) => setPassphrase(event.target.value)}
            />
          </div>
          {step.isNew && (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="sync-confirm">Repeat passphrase</Label>
              <Input
                id="sync-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(event) => setConfirm(event.target.value)}
              />
            </div>
          )}
          <p className="text-sm text-muted-foreground">
            {step.isNew
              ? "Your notes are encrypted on this device with this passphrase before they're uploaded, so nobody else can read them. Keep it somewhere safe: if you forget it, the cloud copy can't be recovered. The notes on your devices aren't affected."
              : "Enter the passphrase you set on your other device."}
          </p>
        </>
      )}

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <div className="flex justify-end gap-2">
        {step.kind !== "email" && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              setStep({ kind: "email" });
              setCode("");
              setPassphrase("");
              setConfirm("");
              setError(null);
            }}
          >
            Back
          </Button>
        )}
        <Button type="submit" size="sm" disabled={busy}>
          {busy
            ? step.kind === "passphrase"
              ? "Unlocking…"
              : "Please wait…"
            : step.kind === "email"
              ? "Send code"
              : step.kind === "code"
                ? "Continue"
                : "Turn on sync"}
        </Button>
      </div>
    </form>
  );
};

const SyncSection = () => {
  const status = useSelector(syncStatusStore, (state) => state);
  const [signingOut, setSigningOut] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <section className="flex flex-col gap-3">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-medium">Sync</h2>
          <p className="text-sm text-muted-foreground">
            {status.account
              ? `Signed in as ${status.account.email}. ${describe(status)}`
              : "Keep your notes up to date on your Mac, iPad and iPhone. Notes are end-to-end encrypted."}
          </p>
        </div>
        {status.account && (
          <div className="flex shrink-0 gap-2">
            {status.state === "error" && (
              <Button variant="outline" size="sm" onClick={() => void retrySync()}>
                Retry
              </Button>
            )}
            <Button
              variant="outline"
              size="sm"
              disabled={signingOut}
              onClick={async () => {
                setSigningOut(true);
                try {
                  await disableSync();
                } finally {
                  setSigningOut(false);
                }
              }}
            >
              Sign out
            </Button>
          </div>
        )}
      </div>
      {!status.account && status.error && (
        <p role="alert" className="text-sm text-destructive">
          {status.error}
        </p>
      )}
      {status.loaded && !status.account && <SignIn />}
      {status.account && (
        <div>
          <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setDeleting(true)}>
            Delete cloud data…
          </Button>
        </div>
      )}
      <DeleteCloudData open={deleting} onOpenChange={setDeleting} />
    </section>
  );
};

const DeleteCloudData = ({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        setError(null);
        onOpenChange(next);
      }}
    >
      <DialogContent showCloseButton={!busy}>
        <DialogHeader>
          <DialogTitle>Delete cloud data?</DialogTitle>
          <DialogDescription>
            Your synced notes, images and review history will be deleted from the server, and every device will be
            signed out of sync. The notes on your devices are kept. Turning sync on again uploads them.
          </DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose
            render={
              <Button variant="outline" disabled={busy}>
                Cancel
              </Button>
            }
          />
          <Button
            variant="destructive"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                await deleteCloudData();
                onOpenChange(false);
              } catch (cause) {
                setError(cause instanceof Error ? cause.message : String(cause));
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? "Deleting…" : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};

export default SyncSection;
