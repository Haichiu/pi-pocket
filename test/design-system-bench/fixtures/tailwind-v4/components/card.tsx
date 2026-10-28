export function Card({ title, note }: { title: string; note: string }) {
    return (
        <article className="rounded-xl border border-input bg-card p-6 text-card-foreground shadow-card">
            <h3 className="text-2xl">{title}</h3>
            <p className="mt-2 text-sm text-muted-foreground">{note}</p>
        </article>
    );
}
