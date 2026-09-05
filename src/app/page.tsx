export default function Home() {
  return (
    <main>
      <h1>Nudge Creative Generator</h1>
      <p>
        Infrastructure scaffold. The generation logic is not implemented yet —
        see <code>src/app/api/generate/route.ts</code>.
      </p>
      <ul>
        <li>
          <code>GET /api/health</code> — liveness probe used by Railway
        </li>
        <li>
          <code>GET /api/generate</code> — list recent creatives
        </li>
        <li>
          <code>POST /api/generate</code> — create one (stubbed generation)
        </li>
      </ul>
    </main>
  );
}
