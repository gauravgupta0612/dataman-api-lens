export async function GET(req: Request, { params }) { const u = new URL(req.url); u.searchParams.get('include'); }
export async function DELETE(req: Request) {}
