import { generateFollowups } from '../src/server/services/followupService';
async function main() {
  const out = await generateFollowups('What is the capital of France?', 'The capital of France is Paris.');
  console.log(JSON.stringify(out));
}
main();
