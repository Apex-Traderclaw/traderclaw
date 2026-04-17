import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import {
  GATEWAY_CRON_GLOBAL,
  GATEWAY_CRON_JOBS,
  type GatewayCronJobDef,
} from "@/lib/gateway-cron-jobs";
import { Bot, Clock, Copy, KeyRound, Sparkles, Info } from "@/components/ui/icons";

const LLM_PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "google", label: "Google AI" },
  { value: "groq", label: "Groq" },
  { value: "xai", label: "xAI" },
  { value: "mistral", label: "Mistral" },
  { value: "other", label: "Other" },
] as const;

const emptyForm = {
  llmProvider: "",
  llmModel: "",
  llmModelManual: false,
  llmCredential: "",
  telegramToken: "",
  xConsumerKey: "",
  xConsumerSecret: "",
  xAccessToken: "",
  xAccessTokenSecret: "",
};

function buildInitialCronSchedules(jobs: GatewayCronJobDef[]) {
  return Object.fromEntries(jobs.map((j) => [j.id, j.defaultSchedule])) as Record<string, string>;
}

function buildInitialCronEnabled(jobs: GatewayCronJobDef[]) {
  return Object.fromEntries(jobs.map((j) => [j.id, true])) as Record<string, boolean>;
}

export function AgentSettingsPanel() {
  const { toast } = useToast();
  const [form, setForm] = useState(emptyForm);
  const [cronSchedules, setCronSchedules] = useState<Record<string, string>>(() =>
    buildInitialCronSchedules(GATEWAY_CRON_JOBS),
  );
  const [cronEnabled, setCronEnabled] = useState<Record<string, boolean>>(() =>
    buildInitialCronEnabled(GATEWAY_CRON_JOBS),
  );

  const cronJobsByCategory = useMemo(() => {
    const map = new Map<string, GatewayCronJobDef[]>();
    for (const job of GATEWAY_CRON_JOBS) {
      const list = map.get(job.category) ?? [];
      list.push(job);
      map.set(job.category, list);
    }
    return map;
  }, []);

  const cronSnippet = useMemo(() => {
    const jobs = GATEWAY_CRON_JOBS.map((j) => ({
      id: j.id,
      schedule: cronSchedules[j.id] ?? j.defaultSchedule,
      enabled: cronEnabled[j.id] !== false,
    }));
    return JSON.stringify(
      {
        cron: {
          enabled: true,
          maxConcurrentRuns: GATEWAY_CRON_GLOBAL.maxConcurrentRuns,
          sessionRetention: GATEWAY_CRON_GLOBAL.sessionRetention,
          jobs,
        },
      },
      null,
      2,
    );
  }, [cronSchedules, cronEnabled]);

  const update = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = () => {
    setForm(emptyForm);
    toast({
      title: "Saved to your VPS",
      description:
        "Your agent host will apply these settings once server-side sync is enabled. Sensitive fields were cleared; cron schedule edits stay in this session until you copy them into your gateway file.",
    });
  };

  const copyCronSnippet = async () => {
    try {
      await navigator.clipboard.writeText(cronSnippet);
      toast({
        title: "Cron snippet copied",
        description: "Paste into your gateway JSON/JSON5 under the cron section and merge with full job messages.",
      });
    } catch {
      toast({
        title: "Copy failed",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="space-y-6" data-testid="agent-settings-panel">
      <Alert className="border-primary/25 bg-muted/30">
        <Info className="h-4 w-4" />
        <AlertTitle className="text-sm">Preview</AlertTitle>
        <AlertDescription className="text-xs text-muted-foreground">
          This mirrors the TraderClaw install wizard: LLM provider, Telegram bot, and optional X (Twitter)
          OAuth. TraderClaw API keys are not shown here — your dashboard session already identifies your account.
          Saving does not persist credentials to our servers yet; fields are cleared locally after you click Save.
        </AlertDescription>
      </Alert>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-foreground" />
            OpenClaw LLM provider
          </CardTitle>
          <CardDescription className="text-xs">
            Provider, optional model override, and API credential — same idea as the installer wizard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="llm-provider">LLM provider</Label>
              <Select
                value={form.llmProvider || undefined}
                onValueChange={(v) => update("llmProvider", v)}
              >
                <SelectTrigger id="llm-provider" data-testid="select-llm-provider">
                  <SelectValue placeholder="Select provider" />
                </SelectTrigger>
                <SelectContent>
                  {LLM_PROVIDERS.map((p) => (
                    <SelectItem key={p.value} value={p.value}>
                      {p.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="llm-model">LLM model {form.llmModelManual ? "" : "(optional)"}</Label>
              <Input
                id="llm-model"
                data-testid="input-llm-model"
                placeholder={form.llmModelManual ? "e.g. gpt-4.1-mini" : "Leave blank for provider default"}
                value={form.llmModel}
                onChange={(e) => update("llmModel", e.target.value)}
                disabled={!form.llmModelManual}
                className={!form.llmModelManual ? "opacity-60" : ""}
              />
            </div>
          </div>
          <div className="flex items-center space-x-2">
            <Checkbox
              id="llm-manual"
              checked={form.llmModelManual}
              onCheckedChange={(c) => update("llmModelManual", c === true)}
              data-testid="checkbox-llm-manual-model"
            />
            <Label htmlFor="llm-manual" className="text-xs font-normal cursor-pointer">
              Choose model manually (advanced)
            </Label>
          </div>
          <div className="space-y-2">
            <Label htmlFor="llm-credential">LLM API key or token</Label>
            <Input
              id="llm-credential"
              type="password"
              autoComplete="off"
              placeholder="Paste credential for the selected provider"
              value={form.llmCredential}
              onChange={(e) => update("llmCredential", e.target.value)}
              data-testid="input-llm-credential"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Bot className="w-4 h-4 text-foreground" />
            Telegram
          </CardTitle>
          <CardDescription className="text-xs">
            Bot token from BotFather — used for guided onboarding and bot commands on your VPS.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="space-y-2">
            <Label htmlFor="telegram-token">Telegram bot token</Label>
            <Input
              id="telegram-token"
              type="password"
              autoComplete="off"
              placeholder="Paste your bot token from BotFather"
              value={form.telegramToken}
              onChange={(e) => update("telegramToken", e.target.value)}
              data-testid="input-telegram-token"
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-foreground" />
            X (Twitter) OAuth 1.0a
          </CardTitle>
          <CardDescription className="text-xs">
            Optional. Leave all blank if you do not use X tools. Same four fields as the install wizard.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="x-consumer-key">X consumer key</Label>
              <Input
                id="x-consumer-key"
                type="password"
                autoComplete="off"
                placeholder="From your X Developer App"
                value={form.xConsumerKey}
                onChange={(e) => update("xConsumerKey", e.target.value)}
                data-testid="input-x-consumer-key"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="x-consumer-secret">X consumer secret</Label>
              <Input
                id="x-consumer-secret"
                type="password"
                autoComplete="off"
                value={form.xConsumerSecret}
                onChange={(e) => update("xConsumerSecret", e.target.value)}
                data-testid="input-x-consumer-secret"
              />
            </div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="space-y-2">
              <Label htmlFor="x-access-token">X access token (main profile)</Label>
              <Input
                id="x-access-token"
                type="password"
                autoComplete="off"
                placeholder="User access token"
                value={form.xAccessToken}
                onChange={(e) => update("xAccessToken", e.target.value)}
                data-testid="input-x-access-token"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="x-access-secret">X access token secret</Label>
              <Input
                id="x-access-secret"
                type="password"
                autoComplete="off"
                value={form.xAccessTokenSecret}
                onChange={(e) => update("xAccessTokenSecret", e.target.value)}
                data-testid="input-x-access-secret"
              />
            </div>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="card-gateway-cron-jobs">
        <CardHeader>
          <CardTitle className="text-sm font-medium flex items-center gap-2">
            <Clock className="w-4 h-4 text-foreground" />
            Gateway cron jobs
          </CardTitle>
          <CardDescription className="text-xs">
            Matches OpenClaw gateway V1-upgraded job IDs. Edit schedules here, then paste into your VPS gateway
            config (e.g. <span className="font-mono">gateway-v1-upgraded.json5</span>) — server-side sync is not
            wired yet.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-primary/20 bg-muted/20">
            <Info className="h-4 w-4" />
            <AlertTitle className="text-xs">Schedules only in this browser</AlertTitle>
            <AlertDescription className="text-[11px] text-muted-foreground">
              Full job prompts (<span className="font-mono">message</span>) stay in the gateway file. This panel
              only helps you tune <span className="font-mono">schedule</span> and <span className="font-mono">enabled</span>{" "}
              before you copy the snippet below.
            </AlertDescription>
          </Alert>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs rounded-md border border-border/60 bg-muted/15 px-3 py-2">
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">maxConcurrentRuns</span>
              <span className="font-mono">{GATEWAY_CRON_GLOBAL.maxConcurrentRuns}</span>
            </div>
            <div className="flex justify-between gap-2">
              <span className="text-muted-foreground">sessionRetention</span>
              <span className="font-mono">{GATEWAY_CRON_GLOBAL.sessionRetention}</span>
            </div>
          </div>

          <div className="space-y-6">
            {Array.from(cronJobsByCategory.entries()).map(([category, jobs]) => (
              <div key={category} className="space-y-2">
                <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {category}
                </div>
                <div className="space-y-3">
                  {jobs.map((job) => (
                    <div
                      key={job.id}
                      className="rounded-lg border border-border/70 bg-background/40 p-3 space-y-2"
                      data-testid={`cron-job-${job.id}`}
                    >
                      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-sm font-medium">{job.title}</span>
                            <Badge variant="outline" className="text-[9px] font-mono font-normal">
                              {job.id}
                            </Badge>
                          </div>
                          <p className="text-[11px] leading-snug text-muted-foreground">{job.shortDescription}</p>
                        </div>
                        <div className="flex shrink-0 items-center gap-2">
                          <Label
                            htmlFor={`cron-en-${job.id}`}
                            className="whitespace-nowrap text-[10px] text-muted-foreground"
                          >
                            On
                          </Label>
                          <Switch
                            id={`cron-en-${job.id}`}
                            checked={cronEnabled[job.id] !== false}
                            onCheckedChange={(c) =>
                              setCronEnabled((prev) => ({ ...prev, [job.id]: c }))
                            }
                            data-testid={`switch-cron-${job.id}`}
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor={`cron-schedule-${job.id}`} className="text-[10px] text-muted-foreground">
                          Cron schedule (5-field)
                        </Label>
                        <Input
                          id={`cron-schedule-${job.id}`}
                          className="h-8 font-mono text-xs"
                          value={cronSchedules[job.id] ?? job.defaultSchedule}
                          placeholder={job.defaultSchedule}
                          onChange={(e) =>
                            setCronSchedules((prev) => ({ ...prev, [job.id]: e.target.value }))
                          }
                          data-testid={`input-cron-schedule-${job.id}`}
                        />
                        <p className="text-[10px] text-muted-foreground">
                          Default: <span className="font-mono">{job.defaultSchedule}</span> — standard cron
                          syntax; server uses gateway timezone.
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <Button type="button" variant="outline" size="sm" className="gap-1.5 w-fit" onClick={copyCronSnippet}>
              <Copy className="w-3.5 h-3.5" />
              Copy cron JSON snippet
            </Button>
            <p className="text-[10px] text-muted-foreground">
              Snippet includes <span className="font-mono">id</span>, <span className="font-mono">schedule</span>,{" "}
              <span className="font-mono">enabled</span> — merge with your full gateway file on the VPS.
            </p>
          </div>
        </CardContent>
      </Card>

      <Separator />

      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <Button type="button" onClick={handleSave} data-testid="button-agent-settings-save">
          Save agent settings
        </Button>
        <p className="text-xs text-muted-foreground">
          Placeholder: credentials are not sent to the server yet. After Save, credential fields reset; cron edits
          remain until you refresh the page.
        </p>
      </div>
    </div>
  );
}
