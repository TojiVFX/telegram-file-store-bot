import app from './app.js';
import { validateEnv } from './env-validator.js';

const envCheck = validateEnv();
if (!envCheck.ok) {
  process.exit(1);
}

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});
