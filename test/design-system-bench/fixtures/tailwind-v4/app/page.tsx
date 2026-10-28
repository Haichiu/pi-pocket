import { Card } from "@/components/card";

// The landing page. Spacing comes from Tailwind's scale: 1 unit = 0.25rem (4 px).
export default function Page() {
    return (
        <main className="mx-auto max-w-3xl space-y-12 px-4 py-8">
            <section className="rounded-2xl bg-brand-100 p-8 text-brand-900 shadow-pop">
                <h1 className="text-6xl">Plants, delivered</h1>
                <p className="mt-3 text-xl text-ink-700">A new green friend every month.</p>
                <a
                    className="mt-6 inline-block rounded-lg bg-primary px-4 py-2 text-sm text-primary-foreground"
                    href="/join"
                >
                    Join now
                </a>
            </section>
            <section className="grid gap-4 sm:grid-cols-2">
                <Card title="Fern" note="Low light" />
                <Card title="Monstera" note="Bright, indirect" />
            </section>
            <p className="rounded-md border border-border bg-sand-100 p-3 text-xs text-muted-foreground">
                Shipping is free over $40.
            </p>
            <p className="text-base text-destructive">Out of stock: Calathea</p>
            <p className="rounded-md bg-[#fff4d6] p-3 text-sm text-warning">Low stock: Pilea</p>
            <p className="text-lg text-success">In stock: Pothos</p>
            <code className="font-mono text-2xl">npm i plants</code>
            <h2 className="text-4xl">Care guides</h2>
        </main>
    );
}
