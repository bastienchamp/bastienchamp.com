import app from './api/server.js' // importe l’app Express exportée 

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server on http://localhost:${PORT}`);
});
