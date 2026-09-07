/**
 * The shell.
 *
 * A measurement panel, not a trading screen. The visual register is deliberately
 * closer to an instrument readout than to a broker terminal: no accent colour reserved
 * for "buy", no motion, nothing that rewards a quick glance with a direction.
 */

import type { ReactNode } from 'react';
import './globals.css';

export const metadata = {
  title: 'Trading Intelligence Terminal',
  description: 'Measured fundamental conditions, with provenance.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="masthead">
          <h1>Trading Intelligence Terminal</h1>
          <p className="masthead-note">
            Measurements of current conditions. Not forecasts, and not trading advice.
          </p>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
