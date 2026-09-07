import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "AgriFeed",
  description: "A decentralized commodity price oracle for Stellar.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
