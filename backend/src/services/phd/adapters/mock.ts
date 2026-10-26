import type { PhdSourceAdapter } from '../types.js';
import { normalizePhdListing, type RawPhdListing } from '../normalize.js';

/**
 * Local fixtures. Every record is explicitly marked `simulated` and uses example.org URLs,
 * so it can never be mistaken for a real advertisement. It exists to exercise discovery,
 * filtering, scoring, and letter drafting without contacting universities.
 */
const now = Date.now();
const daysAgo = (days: number) => new Date(now - days * 86_400_000);
const daysAhead = (days: number) => new Date(now + days * 86_400_000);

const FIXTURES: RawPhdListing[] = [
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-kg-001',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/knowledge-graphs-graph-learning',
    institution: 'Demo University of Technology',
    title: 'Doctoral Researcher in Knowledge Graphs and Graph Machine Learning',
    researchGroup: 'Data Intelligence Lab',
    department: 'Faculty of Computer Science',
    location: 'Dresden, Germany',
    country: 'Germany',
    workArrangement: 'hybrid',
    researchTopic: 'Knowledge graphs, graph representation learning and graph neural networks',
    description: `The Data Intelligence Lab invites applications for a doctoral researcher position on knowledge graphs and graph machine learning.

Your profile
- A master's degree in computer science or a related field
- Strong programming skills in Python
- Experience with knowledge graphs, RDF or property graphs
- Familiarity with graph neural networks or graph representation learning
- English is the working language; German is not required

Tasks
- Design graph representation learning methods for evolving knowledge graphs
- Publish and present research results
- Contribute to research software used by the group

We offer a funded position (TV-L E13, 65%) for three years, starting as soon as possible. Applications close on ${daysAhead(48).toISOString().slice(0, 10)}.`,
    requiredQualifications: ["Master's degree in computer science or related field"],
    requiredSkills: ['Python', 'Knowledge graphs', 'Graph neural networks'],
    requiredLanguages: ['English'],
    funding: 'TV-L E13, 65%, three years',
    salary: 'TV-L E13 (65%)',
    employmentRequirements: ['Master’s degree completed before the start date'],
    postedAt: daysAgo(6),
    applicationDeadline: daysAhead(48),
    expectedStartDate: 'As soon as possible',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-rag-002',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/rag-scientific-knowledge',
    institution: 'Demo Institute for Applied AI',
    title: 'PhD Researcher – Retrieval-Augmented Generation for Scientific Knowledge',
    researchGroup: 'Knowledge Systems Group',
    location: 'Berlin, Germany',
    country: 'Germany',
    workArrangement: 'onsite',
    researchTopic: 'Retrieval-Augmented Generation, large language models and information retrieval',
    description: `We are looking for a PhD researcher to study retrieval-augmented generation over scientific literature and knowledge graphs.

Requirements
- Master's degree in computer science, computational linguistics or a related discipline
- Experience with Python and PyTorch
- Knowledge of large language models and retrieval methods
- Experience with NLP evaluation is an advantage
- Excellent English; German language skills are not required

The position is funded for three years. The application deadline is ${daysAhead(30).toISOString().slice(0, 10)}.`,
    requiredQualifications: ["Master's degree in computer science or related discipline"],
    requiredSkills: ['Python', 'PyTorch', 'Large language models', 'Retrieval-Augmented Generation', 'NLP'],
    requiredLanguages: ['English'],
    funding: 'Three-year doctoral contract',
    salary: 'TV-L E13 (75%)',
    postedAt: daysAgo(2),
    applicationDeadline: daysAhead(30),
    expectedStartDate: 'October 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-stkg-003',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/spatio-temporal-knowledge-graphs',
    institution: 'Demo Technical University of Munich',
    title: 'Doctoral Position in Spatio-Temporal Knowledge Graphs',
    researchGroup: 'Semantic Data Systems',
    location: 'Munich, Germany',
    country: 'Germany',
    workArrangement: 'onsite',
    researchTopic: 'Spatio-temporal knowledge graphs, semantic web and ontologies',
    description: `The Semantic Data Systems group offers a doctoral position on spatio-temporal knowledge graphs.

Your qualifications
- MSc in computer science, information systems or a related field
- Experience with semantic web technologies (RDF, OWL, SPARQL)
- Solid programming skills in Python or Java
- Interest in ontologies and linked data
- Very good English; German is a plus, not a requirement

Funding is available for three years. Apply by ${daysAhead(21).toISOString().slice(0, 10)}.`,
    requiredQualifications: ['MSc in computer science or information systems'],
    requiredSkills: ['Python', 'SPARQL', 'RDF', 'Semantic web', 'Ontologies'],
    requiredLanguages: ['English'],
    funding: 'Three-year funded position',
    postedAt: daysAgo(12),
    applicationDeadline: daysAhead(21),
    expectedStartDate: 'January 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-nlp-004',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/nlp-llm-evaluation',
    institution: 'Demo University of Hamburg',
    title: 'PhD Candidate in NLP and LLM Evaluation',
    researchGroup: 'Language Technology',
    location: 'Hamburg, Germany',
    country: 'Germany',
    workArrangement: 'remote',
    researchTopic: 'Natural language processing, large language models and evaluation methods',
    description: `The Language Technology group is hiring a PhD candidate to work on robust evaluation of large language models.

What you bring
- A completed master's degree in NLP, computer science or linguistics
- Strong Python skills and experience with transformer models
- Knowledge of evaluation methodology and statistics
- English is the team language. German is not required.

The position can be carried out remotely within Germany. Funding is provided for three years.`,
    requiredQualifications: ["Master's degree in NLP, computer science or linguistics"],
    requiredSkills: ['Python', 'Transformers', 'NLP', 'Statistics'],
    requiredLanguages: ['English'],
    funding: 'Three-year position',
    postedAt: daysAgo(20),
    applicationDeadline: daysAhead(60),
    expectedStartDate: 'Flexible',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-semantic-nl-005',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/semantic-web-remote-eu',
    institution: 'Demo Institute for Semantic Systems',
    title: 'Doctoral Researcher – Semantic Web and Knowledge Infrastructures',
    researchGroup: 'Semantic Systems',
    location: 'Amsterdam, Netherlands',
    country: 'Netherlands',
    workArrangement: 'remote',
    remoteEligibleFromGermany: true,
    researchTopic: 'Semantic web, linked data and knowledge infrastructures',
    description: `Fully remote doctoral position (EU-wide) on semantic web infrastructures.

Requirements
- Master's degree in computer science or a related field
- Experience with RDF, SPARQL and linked data
- Python or Java programming skills
- English working language; German is not required

The advertisement explicitly states that the position may be carried out remotely from Germany.`,
    requiredQualifications: ["Master's degree in computer science"],
    requiredSkills: ['Python', 'SPARQL', 'RDF', 'Semantic web', 'Linked data'],
    requiredLanguages: ['English'],
    funding: 'Four-year doctoral contract',
    postedAt: daysAgo(9),
    applicationDeadline: daysAhead(40),
    expectedStartDate: 'March 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-german-required-007',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/german-required-position',
    institution: 'Demo University of Leipzig',
    title: 'Doktorand:in Wissensgraphen (Deutschkenntnisse erforderlich)',
    location: 'Leipzig, Germany',
    country: 'Germany',
    workArrangement: 'onsite',
    researchTopic: 'Wissensgraphen und Semantic Web',
    description: `Die Arbeitsgruppe sucht eine:n Doktorand:in im Bereich Wissensgraphen.

Voraussetzungen
- Abgeschlossenes Masterstudium der Informatik
- Sehr gute Deutschkenntnisse (C1) sind zwingend erforderlich
- Deutsch ist Voraussetzung für die Lehre und die Betreuung

Englischkenntnisse sind von Vorteil.`,
    requiredQualifications: ['Abgeschlossenes Masterstudium'],
    requiredSkills: ['Knowledge graphs'],
    postedAt: daysAgo(4),
    applicationDeadline: daysAhead(35),
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-hybrid-nl-006',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/hybrid-netherlands',
    institution: 'Demo Institute for Semantic Systems',
    title: 'PhD Position in Knowledge Graph Construction (hybrid, Netherlands)',
    location: 'Utrecht, Netherlands',
    country: 'Netherlands',
    workArrangement: 'hybrid',
    researchTopic: 'Knowledge graphs',
    description: `Hybrid doctoral position in Utrecht on knowledge graph construction. Master's degree required. English working language.`,
    requiredQualifications: ["Master's degree"],
    requiredSkills: ['Knowledge graphs', 'Python'],
    postedAt: daysAgo(5),
    applicationDeadline: daysAhead(50),
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-ca-008',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/machine-learning-health-data',
    institution: 'Demo University of Toronto',
    title: 'PhD Position in Machine Learning for Health Data',
    researchGroup: 'Machine Learning and Health Lab',
    department: 'Department of Computer Science',
    location: 'Toronto, Canada',
    country: 'Canada',
    workArrangement: 'onsite',
    researchTopic: 'Machine learning, deep learning and clinical data',
    description: `The Machine Learning and Health Lab invites applications for a fully funded doctoral position on machine learning for clinical data.\n\nRequirements\n- Master's degree in computer science, statistics or a related field\n- Strong Python and PyTorch skills\n- Experience with machine learning and deep learning methods\n- English is the working language\n\nThe position is fully funded for four years, including a stipend and a tuition waiver. Apply by ${daysAhead(45).toISOString().slice(0, 10)}.`,
    requiredQualifications: ["Master's degree in computer science or a related field"],
    requiredSkills: ['Python', 'PyTorch', 'Machine learning', 'Deep learning'],
    requiredLanguages: ['English'],
    funding: 'Fully funded for four years, including a stipend and a tuition waiver',
    salary: 'CAD 30,000 per year (stipend)',
    postedAt: daysAgo(8),
    applicationDeadline: daysAhead(45),
    expectedStartDate: 'September 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-us-009',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/trustworthy-secure-software',
    institution: 'Demo Institute of Technology',
    title: 'Doctoral Researcher in Trustworthy and Secure Software Systems',
    researchGroup: 'Secure Systems Group',
    department: 'Department of Electrical Engineering and Computer Science',
    location: 'Boston, United States',
    country: 'United States',
    workArrangement: 'onsite',
    researchTopic: 'Cybersecurity, secure software engineering and program analysis',
    description: `The Secure Systems Group is hiring a doctoral researcher in cybersecurity and secure software engineering.\n\nQualifications\n- Master's degree in computer science or a related field\n- Experience with software security and program analysis\n- Strong Python or C++ programming skills\n- English is the working language\n\nThe doctoral studentship is fully funded for five years and includes a research assistantship and a tuition waiver. Apply by ${daysAhead(38).toISOString().slice(0, 10)}.`,
    requiredQualifications: ["Master's degree in computer science or a related field"],
    requiredSkills: ['Python', 'C++', 'Machine learning'],
    requiredLanguages: ['English'],
    funding: 'Fully funded doctoral studentship for five years',
    salary: 'USD 42,000 per year (research assistantship)',
    postedAt: daysAgo(11),
    applicationDeadline: daysAhead(38),
    expectedStartDate: 'August 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-tr-010',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/software-engineering-program-analysis',
    institution: 'Demo Middle East Technical University',
    title: 'PhD Scholarship in Software Engineering and Program Analysis',
    researchGroup: 'Software Engineering Research Group',
    department: 'Department of Computer Engineering',
    location: 'Ankara, Turkey',
    country: 'Turkey',
    workArrangement: 'onsite',
    researchTopic: 'Software engineering, program analysis and automated testing',
    description: `The Software Engineering Research Group offers a fully funded doctoral scholarship on software engineering and program analysis.\n\nRequirements\n- MSc in computer science, software engineering or a related field\n- Experience with program analysis or test automation\n- Solid programming skills in Python or Java\n- English is the working language\n\nThe doctoral scholarship is fully funded for four years. Apply by ${daysAhead(33).toISOString().slice(0, 10)}.`,
    requiredQualifications: ['MSc in computer science or software engineering'],
    requiredSkills: ['Python', 'Java', 'Software engineering'],
    requiredLanguages: ['English'],
    funding: 'Fully funded doctoral scholarship for four years',
    salary: 'TRY 25,000 per month (scholarship)',
    postedAt: daysAgo(7),
    applicationDeadline: daysAhead(33),
    expectedStartDate: 'February 2027',
  },
  {
    source: 'phd_mock',
    sourceJobId: 'mock-phd-my-011',
    sourceLabel: 'Simulated PhD source',
    simulated: true,
    url: 'https://example.org/phd/data-science-knowledge-graphs',
    institution: 'Demo University of Malaya',
    title: 'PhD Candidate in Data Science and Knowledge Graphs',
    researchGroup: 'Data Systems and Knowledge Engineering Lab',
    department: 'Faculty of Computer Science and Information Technology',
    location: 'Kuala Lumpur, Malaysia',
    country: 'Malaysia',
    workArrangement: 'hybrid',
    researchTopic: 'Data science, knowledge graphs and semantic web',
    description: `The Data Systems and Knowledge Engineering Lab is hiring a PhD candidate on data science and knowledge graphs.\n\nYour profile\n- Master's degree in computer science, data science or a related field\n- Strong Python and SQL skills\n- Experience with knowledge graphs or semantic web technologies\n- English is the working language\n\nThe PhD studentship is fully funded for three years, including a monthly stipend. Apply by ${daysAhead(52).toISOString().slice(0, 10)}.`,
    requiredQualifications: ["Master's degree in computer science or data science"],
    requiredSkills: ['Python', 'SQL', 'Knowledge graphs'],
    requiredLanguages: ['English'],
    funding: 'Fully funded PhD studentship for three years',
    salary: 'MYR 3,000 per month (stipend)',
    postedAt: daysAgo(3),
    applicationDeadline: daysAhead(52),
    expectedStartDate: 'March 2027',
  },
];

export const phdMockAdapter: PhdSourceAdapter = {
  id: 'phd_mock',
  label: 'Simulated PhD source',
  description:
    'Local fixtures for testing the PhD workflow. Every listing is labelled simulated and uses example.org URLs; no university is contacted.',
  simulated: true,
  isConfigured: () => true,
  async searchPositions({ maxPositions }) {
    const listings = FIXTURES.slice(0, maxPositions)
      .map((fixture) => normalizePhdListing(fixture))
      .filter((listing): listing is NonNullable<typeof listing> => listing !== null);
    return listings;
  },
};
