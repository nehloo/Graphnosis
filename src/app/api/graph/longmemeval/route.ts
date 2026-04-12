import { NextResponse } from 'next/server';
import { runAllTests } from '@/../tests/longmemeval/longmemeval.test';

export async function GET() {
  const results = runAllTests();
  return NextResponse.json(results);
}
