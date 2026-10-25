import type { HydratedDocument } from 'mongoose';
import type { ApplicationRecord } from '../models/Application.js';
import type { CandidateProfileRecord } from '../models/CandidateProfile.js';
import type { CoverLetterRecord } from '../models/CoverLetter.js';
import type { DocumentRecord } from '../models/Document.js';
import type { JobRecord } from '../models/Job.js';
import type { JobMatchRecord } from '../models/JobMatch.js';
import type { SearchRunRecord } from '../models/SearchRun.js';

export type ApplicationDoc = HydratedDocument<ApplicationRecord>;
export type ProfileDoc = HydratedDocument<CandidateProfileRecord>;
export type CoverLetterDoc = HydratedDocument<CoverLetterRecord>;
export type DocumentDoc = HydratedDocument<DocumentRecord>;
export type JobDoc = HydratedDocument<JobRecord>;
export type JobMatchDoc = HydratedDocument<JobMatchRecord>;
export type SearchRunDoc = HydratedDocument<SearchRunRecord>;
