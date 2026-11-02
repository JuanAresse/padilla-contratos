// Client layouts and document bodies are not part of the public edition.
export async function renderPdf(){
  const error=new Error('PDF generation requires a separately configured private renderer');
  error.statusCode=503;
  throw error;
}
