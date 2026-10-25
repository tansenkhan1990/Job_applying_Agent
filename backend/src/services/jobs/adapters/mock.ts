import { env } from '../../../config/env.js';
import { normalizeListing } from '../normalize.js';
import type { JobListing, JobSearchCriteria, JobSourceAdapter } from '../types.js';

/**
 * Local test source. Every entry is clearly fictional and labelled as mock data.
 * It exists so the pipeline (filters, matching, preparation, approval) can be
 * exercised end-to-end without touching a real employer.
 */
const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

const SAMPLES: Array<Parameters<typeof normalizeListing>[0]> = [
  {
    source: 'mock',
    sourceJobId: 'mock-fullstack-senior',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/senior-full-stack-engineer',
    applicationUrl: 'https://example.com/mock-jobs/senior-full-stack-engineer/apply',
    employer: 'Example Commerce GmbH (fictional)',
    title: 'Senior Full Stack Engineer',
    location: 'Berlin, Germany',
    country: 'Germany',
    remote: false,
    workArrangement: 'hybrid',
    employmentType: 'full-time',
    salary: '€75,000 – €95,000',
    tags: ['TypeScript', 'React', 'Node.js', 'PostgreSQL'],
    postedAt: daysAgo(2),
    expiresAt: null,
    description: `We are building a checkout platform for European retailers.
Responsibilities: design and ship features with React, TypeScript, Node.js and PostgreSQL; own REST APIs; improve CI/CD with Docker; collaborate with product and design.
Requirements: 4+ years of professional software engineering experience, strong TypeScript and React, solid Node.js and SQL, experience with Docker and automated testing. English is our working language.
Nice to have: GraphQL, MongoDB, Kubernetes.
Please answer as part of your application: How many years of professional experience do you have with TypeScript?`,
  },
  {
    source: 'mock',
    sourceJobId: 'mock-ai-engineer-rag',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/ai-engineer-rag',
    applicationUrl: 'https://example.com/mock-jobs/ai-engineer-rag/apply',
    employer: 'Example AI Labs (fictional)',
    title: 'AI Engineer (LLM & RAG)',
    location: 'Remote – European Union',
    country: 'European Union',
    remote: true,
    workArrangement: 'remote',
    employmentType: 'full-time',
    salary: '',
    tags: ['Python', 'RAG', 'LLM', 'FastAPI'],
    postedAt: daysAgo(1),
    expiresAt: null,
    description: `Join a small applied-AI team building retrieval-augmented assistants for legal teams.
You will: build RAG pipelines in Python, integrate OpenAI-compatible LLM APIs, design evaluation harnesses, and deploy FastAPI services.
Requirements: Python, experience shipping LLM applications, understanding of embeddings and vector search, strong written English. Experience with LangGraph or agent frameworks is a plus. German is not required.
We work remotely across the EU.`,
  },
  {
    source: 'mock',
    sourceJobId: 'mock-platform-engineer',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/platform-engineer-kubernetes',
    applicationUrl: 'https://example.com/mock-jobs/platform-engineer-kubernetes/apply',
    employer: 'Example Cloud Infrastructure AG (fictional)',
    title: 'Platform Engineer (Kubernetes / AWS)',
    location: 'Munich, Germany',
    country: 'Germany',
    remote: false,
    workArrangement: 'onsite',
    employmentType: 'full-time',
    salary: '€80,000 – €100,000',
    tags: ['Kubernetes', 'AWS', 'Terraform', 'CI/CD'],
    postedAt: daysAgo(4),
    expiresAt: null,
    description: `Own our internal developer platform. You will operate Kubernetes clusters on AWS, write Terraform modules, improve GitHub Actions pipelines, and build observability with Prometheus and Grafana.
Requirements: production Kubernetes, AWS, Linux, infrastructure as code, CI/CD. On-call rotation is shared. English working language; basic German helpful but not required.`,
  },
  {
    source: 'mock',
    sourceJobId: 'mock-frontend-intern',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/frontend-intern',
    applicationUrl: 'https://example.com/mock-jobs/frontend-intern/apply',
    employer: 'Example Startup UG (fictional)',
    title: 'Frontend Developer Intern (unpaid)',
    location: 'Berlin, Germany',
    country: 'Germany',
    remote: false,
    workArrangement: 'onsite',
    employmentType: 'internship',
    salary: '',
    tags: ['React'],
    postedAt: daysAgo(3),
    expiresAt: null,
    description:
      'Unpaid internship for students. Learn React and CSS in a small team. This position is a Praktikum and receives no salary.',
  },
  {
    source: 'mock',
    sourceJobId: 'mock-sales',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/sales-representative',
    applicationUrl: 'https://example.com/mock-jobs/sales-representative/apply',
    employer: 'Example Growth GmbH (fictional)',
    title: 'Sales Representative (commission only)',
    location: 'Remote – Germany',
    country: 'Germany',
    remote: true,
    workArrangement: 'remote',
    employmentType: 'contract',
    salary: 'Commission only',
    tags: ['Sales'],
    postedAt: daysAgo(5),
    expiresAt: null,
    description:
      'Commission only sales role. Cold-call leads and close deals. No technical requirements, no base salary.',
  },
  {
    source: 'mock',
    sourceJobId: 'mock-backend-german',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/senior-backend-german',
    applicationUrl: 'https://example.com/mock-jobs/senior-backend-german/apply',
    employer: 'Beispiel Versicherung AG (fictional)',
    title: 'Senior Backend Engineer',
    location: 'Hamburg, Germany',
    country: 'Germany',
    remote: false,
    workArrangement: 'hybrid',
    employmentType: 'full-time',
    salary: '',
    tags: ['Java', 'Spring Boot', 'PostgreSQL'],
    postedAt: daysAgo(6),
    expiresAt: null,
    description: `Entwickle Backend-Services für unsere Versicherungsplattform mit Java und Spring Boot.
Sehr gute Deutschkenntnisse (C1) sind zwingend erforderlich für die Kommunikation mit Fachabteilungen und Kunden. Englisch ist von Vorteil.
Erfahrung mit PostgreSQL und REST-APIs wird vorausgesetzt.`,
  },
  {
    source: 'mock',
    sourceJobId: 'mock-expired-fullstack',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/expired-full-stack',
    applicationUrl: 'https://example.com/mock-jobs/expired-full-stack/apply',
    employer: 'Example Digital GmbH (fictional)',
    title: 'Full Stack Developer',
    location: 'Cologne, Germany',
    country: 'Germany',
    remote: false,
    workArrangement: 'hybrid',
    employmentType: 'full-time',
    salary: '',
    tags: ['React', 'Node.js'],
    postedAt: daysAgo(90),
    expiresAt: daysAgo(10),
    description:
      'Full stack role with React and Node.js. This posting has expired and is kept only as a filter test case.',
  },
  {
    source: 'mock',
    sourceJobId: 'mock-ai-us-only',
    sourceLabel: 'Mock source (fictional)',
    url: 'https://example.com/mock-jobs/ai-engineer-us-only',
    applicationUrl: 'https://example.com/mock-jobs/mock-ai-us-only/apply',
    employer: 'Example AI Corp (fictional)',
    title: 'AI Engineer',
    location: 'Remote – USA only',
    country: 'Other',
    remote: true,
    workArrangement: 'remote',
    employmentType: 'full-time',
    salary: '',
    tags: ['Python', 'LLM'],
    postedAt: daysAgo(2),
    expiresAt: null,
    description:
      'AI engineering role building LLM features in Python. Candidates must be based in the United States. Remote USA only, no international applicants.',
  },
];

export const mockAdapter: JobSourceAdapter = {
  id: 'mock',
  label: 'Mock source (local testing)',
  description:
    'Fictional sample vacancies covering strong matches, an internship, an unpaid/commission role, an expired posting, a German-mandatory role and a US-only remote role. No network access, no real employer.',
  requiresConfiguration: false,
  isConfigured: () => env.ENABLE_MOCK_SOURCE,

  async searchJobs(criteria: JobSearchCriteria): Promise<JobListing[]> {
    const listings = SAMPLES.map(normalizeListing);
    return listings.slice(0, Math.max(criteria.maxJobs, 8));
  },

  async getJobDetails(sourceJobId: string): Promise<JobListing | null> {
    const sample = SAMPLES.find((item) => item.sourceJobId === sourceJobId);
    return sample ? normalizeListing(sample) : null;
  },

  async verifyJob() {
    return { status: 'available' as const, evidence: 'Mock source: availability simulated locally' };
  },
};
