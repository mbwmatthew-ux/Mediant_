import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { useAuth } from '../context/AuthContext'
import UploadPieceModal from '../components/UploadPieceModal'
import styles from './Page.module.css'

const PIECES = [
  // ── Piano ───────────────────────────────────────────────────────────────
  { id:  1, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Clair de Lune',                      composer: 'Claude Debussy',          key: 'D♭ major',  time: '9/8'  },
  { id:  2, instrument: 'Piano',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Invention No. 8 in F major',         composer: 'J.S. Bach',               key: 'F major',   time: '3/4'  },
  { id:  3, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Moonlight Sonata Op. 27 No. 2',      composer: 'Ludwig van Beethoven',     key: 'C♯ minor',  time: '4/4'  },
  { id:  4, instrument: 'Piano',      era: 'Modern',    difficulty: 'Beginner',     title: 'Gymnopédie No. 1',                   composer: 'Erik Satie',              key: 'G major',   time: '3/4'  },
  { id:  5, instrument: 'Piano',      era: 'Classical', difficulty: 'Intermediate', title: 'Sonata K. 331 in A major',           composer: 'Wolfgang A. Mozart',      key: 'A major',   time: '6/8'  },
  { id:  6, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Ballade No. 1 in G minor',           composer: 'Frédéric Chopin',         key: 'G minor',   time: '6/4'  },
  { id:  7, instrument: 'Piano',      era: 'Baroque',   difficulty: 'Beginner',     title: 'Minuet in G major',                  composer: 'J.S. Bach',               key: 'G major',   time: '3/4'  },
  { id:  8, instrument: 'Piano',      era: 'Classical', difficulty: 'Beginner',     title: 'Für Elise',                          composer: 'Ludwig van Beethoven',     key: 'A minor',   time: '3/8'  },
  { id:  9, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Nocturne Op. 9 No. 2',               composer: 'Frédéric Chopin',         key: 'E♭ major',  time: '12/8' },
  { id: 10, instrument: 'Piano',      era: 'Classical', difficulty: 'Intermediate', title: 'Turkish March (Rondo alla Turca)',    composer: 'Wolfgang A. Mozart',      key: 'A major',   time: '2/4'  },
  { id: 11, instrument: 'Piano',      era: 'Classical', difficulty: 'Advanced',     title: 'Sonata Op. 53 "Waldstein"',          composer: 'Ludwig van Beethoven',     key: 'C major',   time: '4/4'  },
  { id: 12, instrument: 'Piano',      era: 'Baroque',   difficulty: 'Beginner',     title: 'Prelude in C major BWV 846',         composer: 'J.S. Bach',               key: 'C major',   time: '4/4'  },
  { id: 13, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Fantasie Impromptu Op. 66',          composer: 'Frédéric Chopin',         key: 'C♯ minor',  time: '4/4'  },
  { id: 14, instrument: 'Piano',      era: 'Modern',    difficulty: 'Intermediate', title: 'Maple Leaf Rag',                     composer: 'Scott Joplin',            key: 'A♭ major',  time: '2/4'  },
  { id: 15, instrument: 'Piano',      era: 'Modern',    difficulty: 'Beginner',     title: 'The Entertainer',                    composer: 'Scott Joplin',            key: 'C major',   time: '2/4'  },
  { id: 16, instrument: 'Piano',      era: 'Modern',    difficulty: 'Advanced',     title: 'Rhapsody in Blue',                   composer: 'George Gershwin',         key: 'B♭ major',  time: '4/4'  },
  { id: 17, instrument: 'Piano',      era: 'Classical', difficulty: 'Advanced',     title: 'Sonata Op. 13 "Pathétique"',         composer: 'Ludwig van Beethoven',     key: 'C minor',   time: '4/4'  },
  { id: 18, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Beginner',     title: 'Waltz in A minor B. 150',            composer: 'Frédéric Chopin',         key: 'A minor',   time: '3/4'  },
  { id: 19, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Hungarian Rhapsody No. 2',           composer: 'Franz Liszt',             key: 'C♯ minor',  time: '4/4'  },
  { id: 20, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Liebestraum No. 3',                  composer: 'Franz Liszt',             key: 'A♭ major',  time: '6/4'  },
  { id: 21, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Arabesque No. 1',                    composer: 'Claude Debussy',          key: 'E major',   time: '3/4'  },
  { id: 22, instrument: 'Piano',      era: 'Classical', difficulty: 'Beginner',     title: 'Sonata K. 545 in C major',           composer: 'Wolfgang A. Mozart',      key: 'C major',   time: '4/4'  },
  { id: 23, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Scherzo No. 2 Op. 31',               composer: 'Frédéric Chopin',         key: 'B♭ minor',  time: '3/4'  },
  { id: 24, instrument: 'Piano',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Goldberg Variations BWV 988',        composer: 'J.S. Bach',               key: 'G major',   time: '3/4'  },
  { id: 25, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Piano Sonata No. 2 "Funeral March"', composer: 'Frédéric Chopin',         key: 'B♭ minor',  time: '4/4'  },
  { id: 26, instrument: 'Piano',      era: 'Modern',    difficulty: 'Intermediate', title: 'Golliwog\'s Cakewalk',               composer: 'Claude Debussy',          key: 'F major',   time: '2/4'  },
  { id: 27, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Impromptu Op. 90 No. 2',             composer: 'Franz Schubert',          key: 'E♭ major',  time: '3/4'  },
  { id: 28, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Beginner',     title: 'Moment Musical Op. 94 No. 3',        composer: 'Franz Schubert',          key: 'F minor',   time: '2/4'  },
  { id: 29, instrument: 'Piano',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Kinderszenen Op. 15 No. 7 "Träumerei"', composer: 'Robert Schumann',    key: 'F major',   time: '4/4'  },
  { id: 30, instrument: 'Piano',      era: 'Classical', difficulty: 'Advanced',     title: 'Piano Concerto No. 21 (Andante)',     composer: 'Wolfgang A. Mozart',      key: 'F major',   time: '6/4'  },

  // ── Violin ──────────────────────────────────────────────────────────────
  { id: 31, instrument: 'Violin',     era: 'Baroque',   difficulty: 'Advanced',     title: 'Partita No. 2 in D minor',           composer: 'J.S. Bach',               key: 'D minor',   time: '4/4'  },
  { id: 32, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Intermediate', title: 'Méditation from Thaïs',              composer: 'Jules Massenet',          key: 'D major',   time: '4/4'  },
  { id: 33, instrument: 'Violin',     era: 'Modern',    difficulty: 'Advanced',     title: 'Violin Sonata No. 1',                composer: 'Béla Bartók',             key: 'Atonal',    time: '4/4'  },
  { id: 34, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Violin Concerto in E minor Op. 64',  composer: 'Felix Mendelssohn',       key: 'E minor',   time: '4/4'  },
  { id: 35, instrument: 'Violin',     era: 'Baroque',   difficulty: 'Intermediate', title: 'Spring — The Four Seasons',          composer: 'Antonio Vivaldi',         key: 'E major',   time: '4/4'  },
  { id: 36, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Zigeunerweisen Op. 20',              composer: 'Pablo de Sarasate',       key: 'G minor',   time: '4/4'  },
  { id: 37, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Violin Concerto in D major Op. 35',  composer: 'Pyotr Tchaikovsky',       key: 'D major',   time: '4/4'  },
  { id: 38, instrument: 'Violin',     era: 'Classical', difficulty: 'Intermediate', title: 'Sonata No. 5 "Spring" Op. 24',       composer: 'Ludwig van Beethoven',     key: 'F major',   time: '4/4'  },
  { id: 39, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Introduction & Rondo Capriccioso',   composer: 'Camille Saint-Saëns',     key: 'A minor',   time: '4/4'  },
  { id: 40, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Violin Concerto No. 1 Op. 26',       composer: 'Max Bruch',               key: 'G minor',   time: '4/4'  },
  { id: 41, instrument: 'Violin',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Caprice No. 24 in A minor',          composer: 'Niccolò Paganini',        key: 'A minor',   time: '2/4'  },
  { id: 42, instrument: 'Violin',     era: 'Baroque',   difficulty: 'Intermediate', title: 'La Folia Op. 5 No. 12',              composer: 'Arcangelo Corelli',       key: 'D minor',   time: '3/4'  },
  { id: 43, instrument: 'Violin',     era: 'Baroque',   difficulty: 'Advanced',     title: 'Double Violin Concerto BWV 1043',    composer: 'J.S. Bach',               key: 'D minor',   time: '4/4'  },

  // ── Cello ───────────────────────────────────────────────────────────────
  { id: 44, instrument: 'Cello',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Cello Suite No. 1 in G major',       composer: 'J.S. Bach',               key: 'G major',   time: '4/4'  },
  { id: 45, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Cello Concerto in A minor Op. 33',   composer: 'Camille Saint-Saëns',     key: 'A minor',   time: '4/4'  },
  { id: 46, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Élégie Op. 24',                      composer: 'Gabriel Fauré',           key: 'C minor',   time: '3/4'  },
  { id: 47, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Cello Concerto in B minor Op. 104',  composer: 'Antonín Dvořák',          key: 'B minor',   time: '4/4'  },
  { id: 48, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Beginner',     title: 'The Swan (Le Cygne)',                composer: 'Camille Saint-Saëns',     key: 'G major',   time: '6/4'  },
  { id: 49, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Cello Concerto in E minor Op. 85',   composer: 'Edward Elgar',            key: 'E minor',   time: '4/4'  },
  { id: 50, instrument: 'Cello',      era: 'Baroque',   difficulty: 'Advanced',     title: 'Cello Suite No. 3 in C major',       composer: 'J.S. Bach',               key: 'C major',   time: '4/4'  },
  { id: 51, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Variations on a Rococo Theme',       composer: 'Pyotr Tchaikovsky',       key: 'A major',   time: '4/4'  },
  { id: 52, instrument: 'Cello',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Kol Nidrei Op. 47',                  composer: 'Max Bruch',               key: 'D minor',   time: '4/4'  },
  { id: 53, instrument: 'Cello',      era: 'Modern',    difficulty: 'Advanced',     title: 'Cello Sonata in D minor',            composer: 'Claude Debussy',          key: 'D minor',   time: '4/4'  },

  // ── Viola ───────────────────────────────────────────────────────────────
  { id: 54, instrument: 'Viola',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Harold in Italy Op. 16',             composer: 'Hector Berlioz',          key: 'B minor',   time: '4/4'  },
  { id: 55, instrument: 'Viola',      era: 'Modern',    difficulty: 'Advanced',     title: 'Viola Concerto',                     composer: 'Béla Bartók',             key: 'Atonal',    time: '4/4'  },
  { id: 56, instrument: 'Viola',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Sonata Op. 120 No. 1',               composer: 'Johannes Brahms',         key: 'F minor',   time: '4/4'  },
  { id: 57, instrument: 'Viola',      era: 'Romantic',  difficulty: 'Beginner',     title: 'The Swan (arr. for Viola)',           composer: 'Camille Saint-Saëns',     key: 'G major',   time: '6/4'  },
  { id: 58, instrument: 'Viola',      era: 'Modern',    difficulty: 'Advanced',     title: 'Lachrymae Op. 48',                   composer: 'Benjamin Britten',        key: 'D minor',   time: '4/4'  },

  // ── Guitar ──────────────────────────────────────────────────────────────
  { id: 59, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Beginner',     title: 'Romanza (Romance Anónimo)',          composer: 'Anonymous',               key: 'E minor',   time: '3/4'  },
  { id: 60, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Recuerdos de la Alhambra',           composer: 'Francisco Tárrega',       key: 'A minor',   time: '3/4'  },
  { id: 61, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Asturias (Leyenda)',                  composer: 'Isaac Albéniz',           key: 'A minor',   time: '3/4'  },
  { id: 62, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Intermediate', title: 'Adelita',                            composer: 'Francisco Tárrega',       key: 'E minor',   time: '3/4'  },
  { id: 63, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Beginner',     title: 'Lágrima',                            composer: 'Francisco Tárrega',       key: 'E major',   time: '3/4'  },
  { id: 64, instrument: 'Guitar',     era: 'Modern',    difficulty: 'Intermediate', title: 'Cavatina',                           composer: 'Stanley Myers',           key: 'G major',   time: '3/4'  },
  { id: 65, instrument: 'Guitar',     era: 'Romantic',  difficulty: 'Advanced',     title: 'Capricho Árabe',                     composer: 'Francisco Tárrega',       key: 'D minor',   time: '3/4'  },
  { id: 66, instrument: 'Guitar',     era: 'Modern',    difficulty: 'Intermediate', title: 'Étude No. 1 in E minor',             composer: 'Heitor Villa-Lobos',      key: 'E minor',   time: '3/4'  },

  // ── Flute ───────────────────────────────────────────────────────────────
  { id: 67, instrument: 'Flute',      era: 'Modern',    difficulty: 'Advanced',     title: 'Syrinx',                             composer: 'Claude Debussy',          key: 'B♭ minor',  time: '4/4'  },
  { id: 68, instrument: 'Flute',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Flute Sonata in E minor BWV 1034',   composer: 'J.S. Bach',               key: 'E minor',   time: '4/4'  },
  { id: 69, instrument: 'Flute',      era: 'Classical', difficulty: 'Intermediate', title: 'Flute Concerto No. 1 in G major',    composer: 'Wolfgang A. Mozart',      key: 'G major',   time: '4/4'  },
  { id: 70, instrument: 'Flute',      era: 'Modern',    difficulty: 'Intermediate', title: 'Flute Sonata',                       composer: 'Francis Poulenc',         key: 'D major',   time: '4/4'  },
  { id: 71, instrument: 'Flute',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Flute Concerto in F major RV 433',   composer: 'Antonio Vivaldi',         key: 'F major',   time: '4/4'  },
  { id: 72, instrument: 'Flute',      era: 'Romantic',  difficulty: 'Advanced',     title: 'Ballade Op. 168',                    composer: 'Gabriel Fauré',           key: 'F♯ minor',  time: '4/4'  },
  { id: 73, instrument: 'Flute',      era: 'Modern',    difficulty: 'Beginner',     title: 'La Flûte de Pan',                    composer: 'Benjamin Godard',         key: 'D major',   time: '3/4'  },

  // ── Clarinet ────────────────────────────────────────────────────────────
  { id: 74, instrument: 'Clarinet',   era: 'Classical', difficulty: 'Advanced',     title: 'Clarinet Concerto in A major',       composer: 'Wolfgang A. Mozart',      key: 'A major',   time: '4/4'  },
  { id: 75, instrument: 'Clarinet',   era: 'Romantic',  difficulty: 'Advanced',     title: 'Clarinet Quintet in B minor Op. 115',composer: 'Johannes Brahms',         key: 'B minor',   time: '4/4'  },
  { id: 76, instrument: 'Clarinet',   era: 'Romantic',  difficulty: 'Intermediate', title: 'Clarinet Sonata No. 1 Op. 120',      composer: 'Johannes Brahms',         key: 'F minor',   time: '4/4'  },
  { id: 77, instrument: 'Clarinet',   era: 'Romantic',  difficulty: 'Advanced',     title: 'Clarinet Concerto No. 1 Op. 73',     composer: 'Carl Maria von Weber',     key: 'F minor',   time: '4/4'  },
  { id: 78, instrument: 'Clarinet',   era: 'Romantic',  difficulty: 'Intermediate', title: 'Fantasiestücke Op. 73',              composer: 'Robert Schumann',         key: 'A minor',   time: '4/4'  },
  { id: 79, instrument: 'Clarinet',   era: 'Romantic',  difficulty: 'Intermediate', title: 'Introduction, Theme & Variations',   composer: 'Gioachino Rossini',       key: 'G major',   time: '4/4'  },

  // ── Trumpet ─────────────────────────────────────────────────────────────
  { id: 80, instrument: 'Trumpet',    era: 'Classical', difficulty: 'Intermediate', title: 'Trumpet Concerto in E♭ major',       composer: 'Joseph Haydn',            key: 'E♭ major',  time: '4/4'  },
  { id: 81, instrument: 'Trumpet',    era: 'Classical', difficulty: 'Advanced',     title: 'Trumpet Concerto in E major',        composer: 'Johann Hummel',           key: 'E major',   time: '4/4'  },
  { id: 82, instrument: 'Trumpet',    era: 'Baroque',   difficulty: 'Beginner',     title: 'Trumpet Sonata in D major',          composer: 'Henry Purcell',           key: 'D major',   time: '4/4'  },
  { id: 83, instrument: 'Trumpet',    era: 'Modern',    difficulty: 'Advanced',     title: 'Trumpet Concerto in A♭ major',       composer: 'Alexander Arutunian',     key: 'A♭ major',  time: '4/4'  },
  { id: 84, instrument: 'Trumpet',    era: 'Romantic',  difficulty: 'Advanced',     title: 'Carnival of Venice',                 composer: 'Jean-Baptiste Arban',     key: 'C major',   time: '3/4'  },
  { id: 85, instrument: 'Trumpet',    era: 'Baroque',   difficulty: 'Intermediate', title: 'Trumpet Concerto in D major',        composer: 'Georg Philipp Telemann',  key: 'D major',   time: '4/4'  },

  // ── Saxophone ───────────────────────────────────────────────────────────
  { id: 86, instrument: 'Saxophone',  era: 'Romantic',  difficulty: 'Advanced',     title: 'Concerto for Alto Saxophone',        composer: 'Alexander Glazunov',      key: 'E♭ major',  time: '4/4'  },
  { id: 87, instrument: 'Saxophone',  era: 'Modern',    difficulty: 'Intermediate', title: 'Tableaux de Provence',               composer: 'Paule Maurice',           key: 'E♭ major',  time: '4/4'  },
  { id: 88, instrument: 'Saxophone',  era: 'Modern',    difficulty: 'Intermediate', title: 'Saxophone Sonata Op. 19',            composer: 'Paul Creston',            key: 'E♭ major',  time: '4/4'  },
  { id: 89, instrument: 'Saxophone',  era: 'Modern',    difficulty: 'Advanced',     title: 'Rapsodie for Orchestra & Saxophone', composer: 'Claude Debussy',          key: 'B minor',   time: '4/4'  },
  { id: 90, instrument: 'Saxophone',  era: 'Modern',    difficulty: 'Advanced',     title: 'Scaramouche',                        composer: 'Darius Milhaud',          key: 'E♭ major',  time: '4/4'  },

  // ── Oboe ────────────────────────────────────────────────────────────────
  { id: 91, instrument: 'Oboe',       era: 'Baroque',   difficulty: 'Intermediate', title: 'Oboe Concerto in D minor',           composer: 'Alessandro Marcello',     key: 'D minor',   time: '4/4'  },
  { id: 92, instrument: 'Oboe',       era: 'Classical', difficulty: 'Advanced',     title: 'Oboe Concerto in C major',           composer: 'Wolfgang A. Mozart',      key: 'C major',   time: '4/4'  },
  { id: 93, instrument: 'Oboe',       era: 'Modern',    difficulty: 'Intermediate', title: 'Oboe Sonata',                        composer: 'Francis Poulenc',         key: 'D major',   time: '4/4'  },
  { id: 94, instrument: 'Oboe',       era: 'Modern',    difficulty: 'Advanced',     title: 'Oboe Concerto in D major',           composer: 'Richard Strauss',         key: 'D major',   time: '4/4'  },
  { id: 95, instrument: 'Oboe',       era: 'Baroque',   difficulty: 'Intermediate', title: 'Oboe Concerto in A minor RV 461',    composer: 'Antonio Vivaldi',         key: 'A minor',   time: '4/4'  },

  // ── Horn ────────────────────────────────────────────────────────────────
  { id: 96, instrument: 'Horn',       era: 'Classical', difficulty: 'Advanced',     title: 'Horn Concerto No. 4 in E♭ major',    composer: 'Wolfgang A. Mozart',      key: 'E♭ major',  time: '4/4'  },
  { id: 97, instrument: 'Horn',       era: 'Romantic',  difficulty: 'Advanced',     title: 'Horn Concerto No. 1 Op. 11',         composer: 'Richard Strauss',         key: 'E♭ major',  time: '4/4'  },
  { id: 98, instrument: 'Horn',       era: 'Romantic',  difficulty: 'Intermediate', title: 'Horn Trio Op. 40',                   composer: 'Johannes Brahms',         key: 'E♭ major',  time: '4/4'  },
  { id: 99, instrument: 'Horn',       era: 'Classical', difficulty: 'Intermediate', title: 'Horn Concerto No. 1 in D major',     composer: 'Joseph Haydn',            key: 'D major',   time: '4/4'  },

  // ── Harp ────────────────────────────────────────────────────────────────
  { id: 100, instrument: 'Harp',      era: 'Modern',    difficulty: 'Advanced',     title: 'Introduction and Allegro',           composer: 'Maurice Ravel',           key: 'G major',   time: '4/4'  },
  { id: 101, instrument: 'Harp',      era: 'Baroque',   difficulty: 'Intermediate', title: 'Harp Concerto in B♭ major',          composer: 'George Frideric Handel',  key: 'B♭ major',  time: '4/4'  },
  { id: 102, instrument: 'Harp',      era: 'Modern',    difficulty: 'Advanced',     title: 'Danse Sacrée et Danse Profane',      composer: 'Claude Debussy',          key: 'D♯ minor',  time: '4/4'  },
  { id: 103, instrument: 'Harp',      era: 'Romantic',  difficulty: 'Intermediate', title: 'Ballade in C major Op. 50',          composer: 'Félix Godefroid',         key: 'C major',   time: '4/4'  },
]

const INSTRUMENTS    = ['All', 'Piano', 'Violin', 'Cello', 'Viola', 'Guitar', 'Flute', 'Clarinet', 'Trumpet', 'Saxophone', 'Oboe', 'Horn', 'Harp']
const ERA_FILTERS    = ['All eras', 'Baroque', 'Classical', 'Romantic', 'Modern']
const DIFF_FILTERS   = ['Any level', 'Beginner', 'Intermediate', 'Advanced']
const difficultyColor = { Beginner: 'green', Intermediate: 'gold', Advanced: 'coral' }

export default function Search() {
  const nav      = useNavigate()
  const { user } = useAuth()
  const [query,      setQuery]      = useState('')
  const [instrument, setInstrument] = useState('All')
  const [era,        setEra]        = useState('All eras')
  const [difficulty, setDifficulty] = useState('Any level')
  const [userPieces, setUserPieces] = useState([])
  const [showUpload, setShowUpload] = useState(false)

  useEffect(() => {
    if (!user) return
    supabase
      .from('user_pieces')
      .select('*')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })
      .then(({ data }) => { if (data) setUserPieces(data) })
  }, [user])

  function handlePieceAdded(piece) {
    setUserPieces(prev => [piece, ...prev])
  }

  const allPieces = [
    ...userPieces.map(p => ({ ...p, userUploaded: true })),
    ...PIECES,
  ]

  const results = allPieces.filter(p => {
    if (query) {
      const q = query.toLowerCase()
      if (!p.title.toLowerCase().includes(q) &&
          !p.composer.toLowerCase().includes(q) &&
          !p.instrument.toLowerCase().includes(q)) return false
    }
    if (instrument !== 'All'       && p.instrument !== instrument) return false
    if (era        !== 'All eras'  && p.era        !== era)        return false
    if (difficulty !== 'Any level' && p.difficulty !== difficulty) return false
    return true
  })

  return (
    <div className={styles.page}>
      {showUpload && (
        <UploadPieceModal
          onClose={() => setShowUpload(false)}
          onAdded={handlePieceAdded}
        />
      )}

      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Music Library</h1>
          <p className={styles.sub}>
            {PIECES.length} pieces across {INSTRUMENTS.length - 1} instruments
            {userPieces.length > 0 ? ` · ${userPieces.length} uploaded by you` : ''}
          </p>
        </div>
        <div className={styles.headerActions}>
          <button className={styles.primaryBtn} onClick={() => setShowUpload(true)}>
            ↑ Upload sheet music
          </button>
        </div>
      </div>

      <div className={styles.toolbar}>
        <input
          className={styles.searchInput}
          type="text"
          placeholder="Search by title, composer, or instrument…"
          value={query}
          onChange={e => setQuery(e.target.value)}
          autoFocus
        />
        <div className={styles.toolbarFilters}>
          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Instrument</span>
            <div className={styles.filterStrip}>
              {INSTRUMENTS.map(f => (
                <button
                  key={f}
                  className={`${styles.filterChip} ${instrument === f ? styles.filterChipActive : ''}`}
                  onClick={() => setInstrument(f)}
                >{f}</button>
              ))}
            </div>
          </div>
          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Era</span>
            <div className={styles.filterStrip}>
              {ERA_FILTERS.map(f => (
                <button
                  key={f}
                  className={`${styles.filterChip} ${era === f ? styles.filterChipActive : ''}`}
                  onClick={() => setEra(f)}
                >{f}</button>
              ))}
            </div>
          </div>
          <div className={styles.filterGroup}>
            <span className={styles.filterGroupLabel}>Level</span>
            <div className={styles.filterStrip}>
              {DIFF_FILTERS.map(f => (
                <button
                  key={f}
                  className={`${styles.filterChip} ${difficulty === f ? styles.filterChipActive : ''}`}
                  onClick={() => setDifficulty(f)}
                >{f}</button>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div className={styles.sectionHeader}>
        <span className={styles.sectionHeaderTitle}>
          {results.length} result{results.length !== 1 ? 's' : ''}
        </span>
      </div>

      {results.length === 0 ? (
        <p className={styles.emptyState}>No pieces match your filters.</p>
      ) : (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead className={styles.tableHead}>
              <tr>
                <th className={styles.th}>Title</th>
                <th className={styles.th}>Composer</th>
                <th className={styles.th}>Instrument</th>
                <th className={styles.th}>Era</th>
                <th className={styles.th}>Level</th>
                <th className={styles.th}>Key · Time</th>
              </tr>
            </thead>
            <tbody>
              {results.map(p => (
                <tr key={p.id} className={styles.tableRow} onClick={() => nav('/record')}>
                  <td className={styles.td}>
                    {p.title}
                    {p.userUploaded && <span className={styles.uploadedTag}> · Uploaded</span>}
                  </td>
                  <td className={styles.tdSoft}>{p.composer}</td>
                  <td className={styles.tdSoft}>{p.instrument}</td>
                  <td className={styles.tdSoft}>{p.era}</td>
                  <td className={styles.td}>
                    <span className={`${styles.diffBadge} ${styles[difficultyColor[p.difficulty]]}`}>
                      {p.difficulty}
                    </span>
                  </td>
                  <td className={styles.tdSoft}>{p.key} · {p.time}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
