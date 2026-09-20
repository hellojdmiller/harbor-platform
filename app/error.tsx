"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return (
    <main className="setup">
      <h1>This view couldn’t load.</h1>
      <p>
        Your saved workspace is unchanged. Try again or contact your
        administrator.
      </p>
      <button onClick={reset}>Try again</button>
    </main>
  );
}
