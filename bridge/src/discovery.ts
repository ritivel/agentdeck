import { Bonjour } from 'bonjour-service';
import { hostname } from 'node:os';

export function advertise(port: number): () => void {
  const bonjour = new Bonjour();
  const service = bonjour.publish({
    name: `AgentDeck on ${hostname()}`,
    type: 'agentdeck',
    port,
    txt: { name: hostname(), v: '1' },
  });
  service.start?.();
  return () => {
    service.stop?.();
    bonjour.destroy();
  };
}
