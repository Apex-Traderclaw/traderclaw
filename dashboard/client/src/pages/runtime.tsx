import { RuntimeAccessSections } from "@/components/runtime-access-sections";

export default function RuntimePage() {
  return (
    <div className="space-y-6 px-4 py-4 sm:px-6 sm:py-6" data-testid="page-runtime">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold" data-testid="text-runtime-title">
          Runtime
        </h1>
        <p className="max-w-3xl text-sm text-muted-foreground">
          View the active runtime plan on this wallet and buy more runtime with the available payment rails.
          <br />
          This surface is dedicated to execution time, active access windows, and staged checkout flows for SOL and $TCLAW.
        </p>
      </div>
      <RuntimeAccessSections />
    </div>
  );
}
