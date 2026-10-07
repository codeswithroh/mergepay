import { FundTab } from '@/components/FundTab';

export default function AppPage() {
  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-4xl mx-auto py-12 px-4">
        <h1 className="text-3xl font-bold text-gray-900 mb-8">MergePay</h1>
        <FundTab />
      </div>
    </div>
  );
}
