export enum NavigationStatus {
  IDLE = 'IDLE',
  INITIALIZING = 'INITIALIZING',
  ACTIVE = 'ACTIVE',
  ERROR = 'ERROR'
}

export interface Location {
  latitude: number;
  longitude: number;
  heading?: number;
}
