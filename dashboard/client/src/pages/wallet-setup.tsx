import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { useLocation } from 'wouter';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { Input } from '@/components/ui/input';
import { SolAmount, SolanaMark } from '@/components/ui/solana-mark';
import { useToast } from '@/hooks/use-toast';
import { KeyRound, Wallet, ShieldCheck, ArrowRight, Copy, CheckCircle2 } from "@/components/ui/icons";

type WalletRow = {
  id: string;
  publicKey: string;
  label: string;
  balanceLamports: number;
  kmsSecured?: boolean;
  kmsWalletId?: string | null;
};

type FundingData = {
  instructions: string;
  minimumFundingSol: number;
};

export default function WalletSetupPage() {
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const [walletLabel, setWalletLabel] = useState('Primary TraderClaw Wallet');
  const [revealedPrivateKey, setRevealedPrivateKey] = useState<string | null>(null);
  const [keySaved, setKeySaved] = useState(false);
  const [copied, setCopied] = useState(false);

  const { data: wallets, isLoading: walletsLoading } = useQuery<WalletRow[]>({
    queryKey: ['/api/wallets'],
  });
  const wallet = wallets?.[0];

  const { data: funding } = useQuery<FundingData>({
    queryKey: ['/api/funding/instructions', wallet?.id ? `?walletId=${wallet.id}` : ''],
    enabled: !!wallet?.id,
  });

  const createWalletMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/wallets', {
        label: walletLabel?.trim() || 'Primary TraderClaw Wallet',
        chain: 'solana',
        includePrivateKey: true,
      });
      return res.json();
    },
    onSuccess: (data) => {
      setRevealedPrivateKey(data?.privateKey || null);
      queryClient.invalidateQueries({ queryKey: ['/api/wallets'] });
      toast({
        title: 'Wallet created',
        description: data?.kmsSecured ? 'Wallet is stored in KMS and ready for funding.' : 'Wallet created.',
      });
    },
    onError: (err: Error) => {
      toast({ title: 'Wallet creation failed', description: err.message, variant: 'destructive' });
    },
  });

  const balanceSol = wallet ? Number(wallet.balanceLamports || 0) / 1e9 : 0;

  if (walletsLoading) {
    return (
      <div className='space-y-4 px-4 py-4 sm:px-6 sm:py-6'>
        <Skeleton className='h-24 w-full' />
        <Skeleton className='h-48 w-full' />
      </div>
    );
  }

  return (
    <div className='space-y-6 px-4 py-4 sm:px-6 sm:py-6'>
      <h1 className='text-2xl font-semibold' data-testid='text-page-title'>Wallet Setup</h1>

      {!wallet ? (
        <Card data-testid='card-create-wallet' className='w-full max-w-2xl xl:max-w-[50%]'>
          <CardHeader>
            <CardTitle className='text-sm font-medium flex items-center gap-2'>
              <KeyRound className='w-4 h-4 text-foreground' />
              Create KMS Wallet
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='space-y-2'>
              <label htmlFor='wallet-label-input' className='text-xs text-muted-foreground'>Wallet label</label>
              <Input id='wallet-label-input' value={walletLabel} onChange={(e) => setWalletLabel(e.target.value)} />
            </div>
            <Button
              className='w-full'
              data-testid='button-create-wallet'
              onClick={() => createWalletMutation.mutate()}
              disabled={createWalletMutation.isPending}
            >
              <Wallet className='w-4 h-4 mr-2' />
              {createWalletMutation.isPending ? 'Creating...' : 'Create Wallet'}
            </Button>
            <p className='text-xs text-muted-foreground'>
              This creates a Solana wallet and stores it in KMS. The private key is shown once below after creation.
            </p>
          </CardContent>
        </Card>
      ) : (
        <Card data-testid='card-wallet-ready'>
          <CardHeader>
            <CardTitle className='text-sm font-medium flex items-center gap-2'>
              <ShieldCheck className='w-4 h-4 text-foreground' />
              Wallet Ready
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-3 text-sm'>
            <div className='flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between'>
              <span className='text-muted-foreground text-xs'>Public Key</span>
              <span className='font-mono text-xs break-all sm:text-right'>{wallet.publicKey}</span>
            </div>
            <div className='flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between'>
              <span className='text-muted-foreground text-xs'>Balance</span>
              <SolAmount value={balanceSol.toFixed(6)} className='text-xs font-mono' markClassName='h-3.5 w-3.5' />
            </div>
            <div className='flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between'>
              <span className='text-muted-foreground text-xs'>KMS Secured</span>
              <Badge variant={wallet.kmsSecured ? 'success' : 'secondary'} className='text-[10px]'>
                {wallet.kmsSecured ? 'Yes' : 'No'}
              </Badge>
            </div>
            {wallet.kmsWalletId ? (
              <div className='flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between'>
                <span className='text-muted-foreground text-xs'>KMS Wallet ID</span>
                <span className='font-mono text-xs break-all sm:text-right'>{wallet.kmsWalletId}</span>
              </div>
            ) : null}
          </CardContent>
        </Card>
      )}

      {revealedPrivateKey ? (
        <Card data-testid='card-private-key' className='border-amber-500/60 bg-amber-500/5'>
          <CardHeader>
            <CardTitle className='text-sm font-medium text-amber-500 flex items-center gap-2'>
              <KeyRound className='w-4 h-4 text-foreground' />
              Private Key — shown once, save it now
            </CardTitle>
          </CardHeader>
          <CardContent className='space-y-4'>
            <div className='relative'>
              <p className='font-mono text-xs break-all p-3 rounded bg-muted select-all' data-testid='text-private-key'>
                {revealedPrivateKey}
              </p>
              <Button
                size='sm'
                variant='outline'
                className='mt-2 w-full'
                data-testid='button-copy-key'
                onClick={() => {
                  navigator.clipboard.writeText(revealedPrivateKey).then(() => {
                    setCopied(true);
                    setTimeout(() => setCopied(false), 3000);
                  });
                }}
              >
                {copied ? (
                  <><CheckCircle2 className='w-3 h-3 mr-2 text-foreground' /> Copied!</>
                ) : (
                  <><Copy className='w-3 h-3 mr-2' /> Copy to clipboard</>
                )}
              </Button>
            </div>
            <p className='text-xs text-amber-600/80'>
              This key will never be shown again. Store it in a password manager or cold storage immediately.
            </p>
            <Button
              variant={keySaved ? 'default' : 'outline'}
              size='sm'
              data-testid='button-confirm-saved'
              onClick={() => setKeySaved(true)}
              className='w-full'
            >
              {keySaved ? (
                <><CheckCircle2 className='w-3 h-3 mr-2 text-foreground' /> Key saved — ready to continue</>
              ) : (
                'I have saved my private key'
              )}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {wallet ? (
        <Card data-testid='card-funding'>
          <CardHeader>
            <CardTitle className='text-sm font-medium'>Fund Wallet</CardTitle>
          </CardHeader>
          <CardContent className='space-y-3'>
            {funding ? (
              <>
                <p className='text-xs text-muted-foreground'>{funding.instructions}</p>
                <p className='flex items-center gap-1.5 text-xs'>
                  <span>Minimum suggested funding:</span>
                  <SolAmount value={funding.minimumFundingSol} className='font-mono' markClassName='h-3.5 w-3.5' />
                </p>
              </>
            ) : (
              <p className='flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground'>
                <span>Fund your wallet by sending</span>
                <SolanaMark className='h-3.5 w-3.5' />
                <span>to:</span>
                <span className='font-mono break-all'>{wallet.publicKey}</span>
              </p>
            )}
            <Button
              onClick={() => setLocation('/')}
              data-testid='button-go-dashboard'
              disabled={revealedPrivateKey !== null && !keySaved}
              title={revealedPrivateKey && !keySaved ? 'Please confirm you have saved your private key first' : undefined}
              className='w-full'
            >
              Continue to Dashboard
              <ArrowRight className='w-4 h-4 ml-2' />
            </Button>
            {revealedPrivateKey && !keySaved ? (
              <p className='text-xs text-amber-500'>Please confirm you have saved your private key before continuing.</p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}
    </div>
  );
}
