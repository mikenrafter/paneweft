// Modelled on ContainMarks src/models.ts: the three fields below are the existing record.
export interface ContainerMappingRecord {
  firstSeenIndex: number;
  cookieStoreId: string;
  backupName: string;
}
