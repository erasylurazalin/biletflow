'use client';

import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

export function TicketQr({ payload }: { payload: string }) {
  const [generated, setGenerated] = useState<{ payload: string; dataUrl: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    QRCode.toDataURL(payload, { errorCorrectionLevel: 'M', margin: 2, width: 240 })
      .then((dataUrl) => {
        if (!cancelled) setGenerated({ payload, dataUrl });
      })
      .catch(() => {
        if (!cancelled) setGenerated(null);
      });

    return () => {
      cancelled = true;
    };
  }, [payload]);

  const dataUrl = generated?.payload === payload ? generated.dataUrl : null;
  if (!dataUrl) return <div className="h-[240px] w-[240px] bg-zinc-200" />;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img src={dataUrl} alt="Ticket QR code" width={240} height={240} className="bg-white" />
  );
}
