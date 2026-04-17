import { ReactNode, useState } from "react";
import { queryClient, startUserSession, getStoredApiKey } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";

type SyncSessionDialogProps = {
  children: ReactNode;
};

export function SyncSessionDialog({ children }: SyncSessionDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [syncLoading, setSyncLoading] = useState(false);
  const [syncApiKey, setSyncApiKey] = useState(getStoredApiKey() || "");
  const [syncPrivateKey, setSyncPrivateKey] = useState("");

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) {
          setSyncApiKey(getStoredApiKey() || syncApiKey);
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Sync Agent Session</DialogTitle>
          <DialogDescription>
            Paste API key to sync this dashboard session. If wallet proof is required, add wallet private key for local
            challenge signing.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <label htmlFor="sync-session-api-key" className="text-xs text-muted-foreground">
              API Key
            </label>
            <Input
              id="sync-session-api-key"
              placeholder="oc_..."
              value={syncApiKey}
              onChange={(e) => setSyncApiKey(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <label htmlFor="sync-session-private-key" className="text-xs text-muted-foreground">
              Wallet Private Key (only if requested by challenge)
            </label>
            <Input
              id="sync-session-private-key"
              type="password"
              placeholder="Base58 or [numbers,...]"
              value={syncPrivateKey}
              onChange={(e) => setSyncPrivateKey(e.target.value)}
            />
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={syncLoading}
            data-testid="button-sync-cancel"
          >
            Cancel
          </Button>
          <Button
            onClick={async () => {
              const apiKey = syncApiKey.trim();
              if (!apiKey) {
                toast({ title: "API key required", variant: "destructive" });
                return;
              }

              try {
                setSyncLoading(true);
                await startUserSession({
                  apiKey,
                  walletPrivateKey: syncPrivateKey.trim() || undefined,
                  clientLabel: "dashboard-sync",
                });
                await queryClient.invalidateQueries();
                setOpen(false);
                setSyncPrivateKey("");
                toast({ title: "Session synced", description: "Dashboard is now synced to the provided API key account." });
              } catch (error) {
                toast({
                  title: "Sync failed",
                  description: error instanceof Error ? error.message : "Unable to sync session",
                  variant: "destructive",
                });
              } finally {
                setSyncLoading(false);
              }
            }}
            disabled={syncLoading}
            data-testid="button-sync-confirm"
          >
            {syncLoading ? "Syncing..." : "Sync"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
