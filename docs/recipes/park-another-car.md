# Park another car

## Goal

The hangout kit's street has a third car anyone can get into with `E` and
drive, the same as the two it ships with. The cars are declared by where they
are parked, so a new car is one more spot.

## Files you will edit

- `src/street.ts`

## Steps

1. **Add a parking spot.** `CAR_SPOTS` lists where each car stands on the floor
   plan, `[x, z]` in metres; every car is parked facing west. The street runs
   along X between the doors, and `STREET_BOUNDS` keeps a driven car inside
   `x` in -10..10 and `z` in -3..3, so park the new one there, clear of the
   others (a car is 3.8 m long).

   ```ts
   /** Where the cars are parked: on the street, facing west (yaw PI/2). */
   export const CAR_SPOTS: readonly (readonly [number, number])[] = [
     [-4, 0],
     [4, 0],
     [0, 2.2],
   ];
   ```

   Nothing else changes. `src/game.ts` spawns one `Sedan` per spot, and
   `src/props.ts` sizes the car lanes (pose, speed, driver) from the same list
   when it finds the cars in `init`.

2. **Rebuild the guest**, because Play Solo's authority runs it:

   ```sh
   npm run build:guest
   ```

## Verify

```sh
npm test
```

passes as before. Then `npm run dev`, open `http://localhost:5196`, walk to the
middle of the street: a third red car stands there, and next to it your HUD
says `E: drive`. Press `E` and `W`: it drives off west.

## See also

- [Play with friends](./play-with-friends.md): two tabs in one room, so a
  friend can take the other car.
- [Send a message](./send-a-message.md): the pattern behind `sit` and
  `cosmetic` in the kit's `src/messages.ts`.
